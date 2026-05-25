import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readlink, realpath, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { execa } from "execa";
import { createBranch, createSandbox } from "./helpers.mjs";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("first `worm init` lazily provisions the global root", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init", "--universes", "2"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /First run/);

  for (const rel of [
    "multiverses",
    "shared",
    "shared/global-rules.md",
    "templates/default/config.json",
    "templates/default/scripts/setup.sh",
  ]) {
    const s = await stat(path.join(sb.wormHome, rel));
    assert.ok(s, `expected ${rel} to exist`);
  }
});

test("worm init binds an existing container, writes self-contained gitignore, is idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r1 = await sb.worm(["init", "--universes", "2"]);
  assert.equal(r1.exitCode, 0, r1.stderr);

  const configLink = await readlink(path.join(sb.projectRoot, ".worm", "config.json"));
  assert.match(configLink, /multiverses\/.+\/config\.json$/);

  const scriptsLink = await readlink(path.join(sb.projectRoot, ".worm", "scripts"));
  assert.match(scriptsLink, /multiverses\/.+\/scripts$/);

  for (const slot of ["uni-0", "uni-1"]) {
    const s = await stat(path.join(sb.projectRoot, ".worm", "universes", slot));
    assert.ok(s.isDirectory());
  }

  // .worm/ self-ignores via its own .gitignore (`*`). Container itself has no
  // working tree so root .gitignore is untouched.
  const localIgnore = await readFile(
    path.join(sb.projectRoot, ".worm", ".gitignore"),
    "utf8"
  );
  assert.equal(localIgnore.trim(), "*");
  await assert.rejects(
    stat(path.join(sb.projectRoot, ".gitignore")),
    /ENOENT/,
    "container has no working tree so worm should not write a root .gitignore"
  );

  const r2 = await sb.worm(["init", "--universes", "2"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /Reused global profile/);
  assert.doesNotMatch(r2.stdout, /First run/, "global init should not run twice");
});

test("worm init refuses to run in a regular clone (not a bare-clone container)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  // The seed repo itself is a normal clone — .git/ is a directory, not a pointer file.
  // findContainerRoot walks up from there, finds nothing, errors out.
  const r = await sb.worm(["init"], { cwd: sb.seedRepo });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Not inside a worm container/);
  assert.match(r.stderr, /worm clone/);
});

test("worm clone builds a bare-clone container and binds it", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const cloneTarget = await mkdtemp(path.join(tmpdir(), "worm-clone-"));
  await rm(cloneTarget, { recursive: true, force: true });
  t.after(() => rm(cloneTarget, { recursive: true, force: true }));

  const r = await sb.worm(["clone", sb.seedRepo, cloneTarget, "--universes", "2"], { cwd: tmpdir() });
  assert.equal(r.exitCode, 0, r.stderr);

  // .bare/ + .git pointer exist.
  const bareStat = await stat(path.join(cloneTarget, ".bare"));
  assert.ok(bareStat.isDirectory());
  const gitPointer = await readFile(path.join(cloneTarget, ".git"), "utf8");
  assert.match(gitPointer, /^gitdir:\s*\.\/?\.bare/);

  // .worm/ scaffolding got laid down.
  await stat(path.join(cloneTarget, ".worm", "universes", "uni-0"));
  await stat(path.join(cloneTarget, ".worm", "universes", "uni-1"));

  // Status works inside the cloned container.
  const status = await sb.worm(["status", "--json"], { cwd: cloneTarget });
  assert.equal(status.exitCode, 0, status.stderr);
  const state = JSON.parse(status.stdout);
  assert.equal(state.slots.length, 2);

  // `git clone --bare` doesn't populate refs/remotes/origin/*; `worm clone`
  // patches that up. Verify `origin/main` resolves inside the container.
  const remoteHead = await execa("git", ["rev-parse", "origin/main"], { cwd: cloneTarget });
  assert.equal(remoteHead.exitCode, 0);
  assert.match(remoteHead.stdout, /^[0-9a-f]{40}$/);
});

test("warp mounts a branch with anchor + shared symlinks (when configured)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  // Defaults are empty — provide a template so we have something to symlink.
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      universes_count: 2,
      anchors: ["node_modules"],
      shared_paths: [".env"],
      hooks: {},
    })
  );

  await sb.worm(["init", "--template", templateDir]);

  const r = await sb.worm(["warp", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);

  const projectName = path.basename(sb.projectRoot);
  const srcPath = path.join(sb.projectRoot, `${projectName}-uni0`);

  const anchor = await readlink(path.join(srcPath, "node_modules"));
  assert.equal(
    anchor,
    "../.worm/universes/uni-0/node_modules",
    "anchor should be a relative symlink up to .worm/"
  );

  const sharedEnv = await readlink(path.join(srcPath, ".env"));
  assert.equal(sharedEnv, "../.worm/shared/.env");

  const srcStat = await stat(srcPath);
  assert.ok(srcStat.isDirectory());
});

test("default config has no anchors or shared_paths — warp creates no symlinks", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "1"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  const projectName = path.basename(sb.projectRoot);
  const srcPath = path.join(sb.projectRoot, `${projectName}-uni0`);

  // No defaults → none of the historically-presumed dirs should appear.
  for (const name of ["node_modules", ".venv", ".env", "CLAUDE.local.md", "SKILL.md"]) {
    await assert.rejects(
      stat(path.join(srcPath, name)),
      /ENOENT/,
      `expected no auto-symlinked "${name}" with the empty defaults`
    );
  }
});

test("status --json reflects slot states", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "2"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  const r = await sb.worm(["status", "--json"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const state = JSON.parse(r.stdout);
  assert.equal(state.slots.length, 2);
  assert.equal(state.slots[0].name, "uni-0");
  assert.equal(state.slots[0].status, "ACTIVE");
  assert.equal(state.slots[0].branch, "feature-a");
  assert.equal(state.slots[1].name, "uni-1");
  assert.equal(state.slots[1].status, "STABLE");
});

test("collapse frees slot, keeps anchors warm, worktree removed", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  // Provide a template with an anchor so we can verify it survives collapse.
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      universes_count: 1,
      anchors: ["node_modules"],
      shared_paths: [],
      hooks: {},
    })
  );

  await sb.worm(["init", "--template", templateDir]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  const r = await sb.worm(["collapse", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);

  const anchor = await stat(
    path.join(sb.projectRoot, ".worm", "universes", "uni-0", "node_modules")
  );
  assert.ok(anchor.isDirectory(), "node_modules anchor should survive collapse");

  const projectName = path.basename(sb.projectRoot);
  await assert.rejects(
    stat(path.join(sb.projectRoot, `${projectName}-uni0`)),
    /ENOENT/,
    "top-level worktree dir should be removed by collapse"
  );

  const status = await sb.worm(["status", "--json"]);
  const state = JSON.parse(status.stdout);
  assert.equal(state.slots[0].status, "STABLE");
});

test("warp into freed slot reuses uni-0 (anchors stay hot)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "2"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);
  await sb.worm(["collapse", "feature-a", "--skip-hook"]);

  const r = await sb.worm(["warp", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /uni-0/);
});

test("warp fails with helpful error when no slot is free", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "a");
  await createBranch(sb.projectRoot, "b");
  await createBranch(sb.projectRoot, "c");

  await sb.worm(["init", "--universes", "2"]);
  await sb.worm(["warp", "a", "--skip-hook"]);
  await sb.worm(["warp", "b", "--skip-hook"]);

  const r = await sb.worm(["warp", "c", "--skip-hook"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /No free universe slot/);
  assert.match(r.stderr, /Collapse an active branch/);
});

test("warp refuses to mount the same branch twice", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "a");

  await sb.worm(["init", "--universes", "2"]);
  await sb.worm(["warp", "a", "--skip-hook"]);

  const r = await sb.worm(["warp", "a", "--skip-hook"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /already active in slot uni-0/);
});

test("warp --create makes a new branch on the fly", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init", "--universes", "1"]);

  const r = await sb.worm(["warp", "brand-new", "--skip-hook", "--create"]);
  assert.equal(r.exitCode, 0, r.stderr);
});

test("warp without --create fails clearly for unknown branch", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init", "--universes", "1"]);

  const r = await sb.worm(["warp", "ghost", "--skip-hook"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /does not exist/);
  assert.match(r.stderr, /--create/);
});

test("WORM_HOME takes precedence over HOME", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init"], {
    home: path.join(sb.projectRoot, "fake-home"),
    wormHome: sb.wormHome,
  });
  assert.equal(r.exitCode, 0, r.stderr);

  await stat(path.join(sb.wormHome, "multiverses"));
  await assert.rejects(
    stat(path.join(sb.projectRoot, "fake-home", ".worm")),
    /ENOENT/
  );
});

test("worm init outside a container errors with a clone hint", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const empty = await mkdtemp(path.join(tmpdir(), "worm-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));

  const r = await sb.worm(["init"], { cwd: empty });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Not inside a worm container/);
  assert.match(r.stderr, /worm clone/);
});

test("commands walk up to find the container from any subdirectory", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init", "--universes", "2"]);

  // Deep subdirectory inside the container — not at the root, not in a worktree yet.
  const deep = path.join(sb.projectRoot, ".worm", "universes", "uni-0");
  const r = await sb.worm(["status", "--json"], { cwd: deep });
  assert.equal(r.exitCode, 0, r.stderr);
  const state = JSON.parse(r.stdout);
  assert.equal(state.slots.length, 2);
});

test("default on_warp hook runs scripts/setup.sh with WORM_* env vars", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await createBranch(sb.projectRoot, "feature-b");

  await sb.worm(["init", "--universes", "2"]);

  // Overwrite the default setup.sh to print the env vars we care about.
  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  await writeFile(
    setupPath,
    `#!/usr/bin/env bash\necho "ROOT=$WORM_PROJECT_ROOT"\necho "SLOT=$WORM_SLOT"\necho "INDEX=$WORM_SLOT_INDEX"\necho "BRANCH=$WORM_BRANCH"\n`
  );
  await chmod(setupPath, 0o755);

  const r1 = await sb.worm(["warp", "feature-a"]);
  assert.equal(r1.exitCode, 0, r1.stderr);
  // On macOS, tmpdir paths resolve through /private/var/..., so compare realpaths.
  const resolvedRoot = await realpath(sb.projectRoot);
  assert.match(r1.stdout, new RegExp(`ROOT=${escapeRegex(resolvedRoot)}`));
  assert.match(r1.stdout, /SLOT=uni-0/);
  assert.match(r1.stdout, /INDEX=0/);
  assert.match(r1.stdout, /BRANCH=feature-a/);

  // Index advances with the slot — uni-1 should see INDEX=1.
  const r2 = await sb.worm(["warp", "feature-b"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /SLOT=uni-1/);
  assert.match(r2.stdout, /INDEX=1/);
});

test("init --template <dir> seeds from a custom template", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));

  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      universes_count: 4,
      anchors: ["vendor"],
      shared_paths: [".envrc"],
      hooks: { on_warp: "echo custom-template" },
    })
  );
  await mkdir(path.join(templateDir, "scripts"), { recursive: true });
  await writeFile(
    path.join(templateDir, "scripts", "setup.sh"),
    "#!/usr/bin/env bash\necho from-template\n"
  );

  const r = await sb.worm(["init", "--template", templateDir]);
  assert.equal(r.exitCode, 0, r.stderr);

  const configPath = path.join(sb.projectRoot, ".worm", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.universes_count, 4);
  assert.deepEqual(config.anchors, ["vendor"]);
  assert.equal(config.hooks.on_warp, "echo custom-template");

  const setupContents = await readFile(
    path.join(sb.projectRoot, ".worm", "scripts", "setup.sh"),
    "utf8"
  );
  assert.match(setupContents, /from-template/);

  for (const slot of ["uni-0", "uni-1", "uni-2", "uni-3"]) {
    const s = await stat(path.join(sb.projectRoot, ".worm", "universes", slot));
    assert.ok(s.isDirectory());
  }
});

test("init --template <missing> errors with a hint", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init", "--template", "/does/not/exist"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Template directory not found/);
});

test("warp refuses when branch is checked out in a non-worm worktree", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-side");

  await sb.worm(["init", "--universes", "2"]);

  // Manually create a worktree OUTSIDE worm's universes claiming the branch.
  const sidePath = await mkdtemp(path.join(tmpdir(), "worm-side-"));
  await rm(sidePath, { recursive: true, force: true });
  await execa("git", ["worktree", "add", sidePath, "feature-side"], { cwd: sb.projectRoot });
  t.after(async () => {
    await execa("git", ["worktree", "remove", "--force", sidePath], { cwd: sb.projectRoot }).catch(() => {});
    await rm(sidePath, { recursive: true, force: true });
  });

  const r = await sb.worm(["warp", "feature-side", "--skip-hook"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /outside the multiverse/);
  assert.match(r.stderr, new RegExp(escapeRegex(sidePath)));
  assert.doesNotMatch(r.stderr, /fatal:/, "should not surface git's raw error");
});

test("worm path resolves by branch and by slot index", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "2"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  // On macOS, process.cwd() inside the spawned CLI resolves /var/... → /private/var/...
  const resolvedRoot = await realpath(sb.projectRoot);
  const projectName = path.basename(sb.projectRoot);
  const expected0 = path.join(resolvedRoot, `${projectName}-uni0`);
  const expected1 = path.join(resolvedRoot, `${projectName}-uni1`);

  // By branch (active warp).
  const byBranch = await sb.worm(["path", "feature-a"]);
  assert.equal(byBranch.exitCode, 0, byBranch.stderr);
  assert.equal(byBranch.stdout.trim(), expected0);

  // By slot index (stable slot, no warp yet — path still resolves).
  const bySlot = await sb.worm(["path", "1"]);
  assert.equal(bySlot.exitCode, 0, bySlot.stderr);
  assert.equal(bySlot.stdout.trim(), expected1);

  // Unknown branch errors with hint.
  const bad = await sb.worm(["path", "ghost-branch"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /not warped/);

  // Out-of-range index errors.
  const oob = await sb.worm(["path", "99"]);
  assert.notEqual(oob.exitCode, 0);
  assert.match(oob.stderr, /out of range/);
});

test("worm completion emits per-shell scripts and rejects unknown shells", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const bash = await sb.worm(["completion", "bash"]);
  assert.equal(bash.exitCode, 0, bash.stderr);
  assert.match(bash.stdout, /^_worm_complete\(\) \{/m);
  assert.match(bash.stdout, /complete -F _worm_complete worm/);
  // Static command list is present.
  assert.match(bash.stdout, /init clone warp/);
  // Branch completion is wired up for the right subcommands.
  assert.match(bash.stdout, /git for-each-ref/);

  const zsh = await sb.worm(["completion", "zsh"]);
  assert.equal(zsh.exitCode, 0, zsh.stderr);
  assert.match(zsh.stdout, /compdef _worm_complete worm/);
  assert.match(zsh.stdout, /git for-each-ref/);

  const bad = await sb.worm(["completion", "fish"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /Unsupported shell/);
});

test("worm shell-init prints a sourceable shell function", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["shell-init"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /^worm\(\) \{/m);
  assert.match(r.stdout, /command worm path/);
  assert.match(r.stdout, /builtin cd/);
});

test("worm config round-trips through ~/.worm/config.json", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);

  // Unset by default.
  const empty = await sb.worm(["config", "editor"]);
  assert.equal(empty.exitCode, 0, empty.stderr);
  assert.match(empty.stdout, /\(unset\)/);

  // Set and read back.
  const set = await sb.worm(["config", "editor", "code"]);
  assert.equal(set.exitCode, 0, set.stderr);

  const persisted = JSON.parse(
    await readFile(path.join(sb.wormHome, "config.json"), "utf8")
  );
  assert.equal(persisted.editor, "code");

  const get = await sb.worm(["config", "editor"]);
  assert.match(get.stdout, /^code$/m);

  // Unknown key surfaces a friendly error.
  const bad = await sb.worm(["config", "made-up-key"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /Unknown config key/);
});

test("warp --open without editor configured errors with a hint", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "1"]);

  const r = await sb.worm(["warp", "feature-a", "--skip-hook", "--open"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /No editor configured/);
  assert.match(r.stderr, /worm config editor/);
});

test("warp --detach works even when the branch is checked out elsewhere", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-busy");

  await sb.worm(["init", "--universes", "1"]);

  // Claim the branch in an external worktree first.
  const sidePath = await mkdtemp(path.join(tmpdir(), "worm-side-"));
  await rm(sidePath, { recursive: true, force: true });
  await execa("git", ["worktree", "add", sidePath, "feature-busy"], { cwd: sb.projectRoot });
  t.after(async () => {
    await execa("git", ["worktree", "remove", "--force", sidePath], { cwd: sb.projectRoot }).catch(() => {});
    await rm(sidePath, { recursive: true, force: true });
  });

  // Without --detach: refused (Item 4 behavior).
  const fail = await sb.worm(["warp", "feature-busy", "--skip-hook"]);
  assert.notEqual(fail.exitCode, 0);
  assert.match(fail.stderr, /outside the multiverse/);

  // With --detach: succeeds; slot is ACTIVE with no branch (detached HEAD).
  const ok = await sb.worm(["warp", "feature-busy", "--skip-hook", "--detach"]);
  assert.equal(ok.exitCode, 0, ok.stderr);

  const status = await sb.worm(["status", "--json"]);
  const state = JSON.parse(status.stdout);
  assert.equal(state.slots[0].status, "ACTIVE");
  // Detached worktree → branch is "(detached)" per universe.ts classifySlot.
  assert.equal(state.slots[0].branch, "(detached)");
});

test("collapse refuses on uncommitted changes; --force discards them", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "1"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  const projectName = path.basename(sb.projectRoot);
  const worktreePath = path.join(sb.projectRoot, `${projectName}-uni0`);

  // Drop an untracked file into the worktree to make it dirty.
  await writeFile(path.join(worktreePath, "scratch.txt"), "uncommitted work\n");

  // Without --force, collapse should refuse and surface the dirty file.
  const fail = await sb.worm(["collapse", "feature-a", "--skip-hook"]);
  assert.notEqual(fail.exitCode, 0);
  assert.match(fail.stderr, /uncommitted changes/);
  assert.match(fail.stderr, /scratch\.txt/);
  assert.match(fail.stderr, /--force/);

  // Worktree is still mounted after the refusal.
  const stillThere = await stat(worktreePath);
  assert.ok(stillThere.isDirectory());

  // With --force, collapse succeeds and discards the worktree (and the file).
  const ok = await sb.worm(["collapse", "feature-a", "--skip-hook", "--force"]);
  assert.equal(ok.exitCode, 0, ok.stderr);
  // logger.warn writes to stderr, so the discard notice lands there.
  assert.match(ok.stderr, /Discarding 1 uncommitted change/);
  await assert.rejects(stat(worktreePath), /ENOENT/);
});

test("worm destroy --force unbinds the project and cleans up everywhere", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--name", "demo", "--universes", "2"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  // Drop an untracked file in the active worktree — destroy --force should still proceed.
  const worktreePath = path.join(sb.projectRoot, "demo-uni0");
  await writeFile(path.join(worktreePath, "scratch.txt"), "dirty\n");

  const r = await sb.worm(["destroy", "--force"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /multiverse is no more/);

  // .worm/ gone.
  await assert.rejects(stat(path.join(sb.projectRoot, ".worm")), /ENOENT/);

  // Top-level worktree dir gone.
  await assert.rejects(stat(worktreePath), /ENOENT/);

  // Global profile gone.
  await assert.rejects(
    stat(path.join(sb.wormHome, "multiverses", "demo")),
    /ENOENT/
  );
});

test("worm destroy without --force refuses in a non-interactive shell", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);

  // sb.worm runs the CLI via execa with no TTY — process.stdin.isTTY is false.
  const r = await sb.worm(["destroy"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /non-interactive/);
  assert.match(r.stderr, /--force/);

  // Nothing should have been touched.
  await stat(path.join(sb.projectRoot, ".worm"));
});

test("worm destroy errors clearly when project isn't bound", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  // Note: NO `worm init` — so the project has no .worm/.

  const r = await sb.worm(["destroy", "--force"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /not bound/);
});

test("worm collapse accepts a slot index as well as a branch name", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await createBranch(sb.projectRoot, "feature-b");

  await sb.worm(["init", "--universes", "2"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);
  await sb.worm(["warp", "feature-b", "--skip-hook"]);

  // Collapse by index — uni-0 was feature-a.
  const r0 = await sb.worm(["collapse", "0", "--skip-hook"]);
  assert.equal(r0.exitCode, 0, r0.stderr);

  let state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots[0].status, "STABLE");
  assert.equal(state.slots[1].status, "ACTIVE");
  assert.equal(state.slots[1].branch, "feature-b");

  // Collapse by branch still works.
  const r1 = await sb.worm(["collapse", "feature-b", "--skip-hook"]);
  assert.equal(r1.exitCode, 0, r1.stderr);

  state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots[1].status, "STABLE");

  // Collapsing a stable slot by index errors with a clear status.
  const bad = await sb.worm(["collapse", "0", "--skip-hook"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /not active/);

  // Out-of-range index errors.
  const oob = await sb.worm(["collapse", "99", "--skip-hook"]);
  assert.notEqual(oob.exitCode, 0);
  assert.match(oob.stderr, /out of range/);
});

test("worm universes prints current count, grows the multiverse, and refuses to shrink past an active slot", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "2"]);

  // Read: no arg → current count.
  const read = await sb.worm(["universes"]);
  assert.equal(read.exitCode, 0, read.stderr);
  assert.equal(read.stdout.trim(), "2");

  // Grow: 2 → 4 creates uni-2 and uni-3 directories.
  const grow = await sb.worm(["universes", "4"]);
  assert.equal(grow.exitCode, 0, grow.stderr);
  assert.match(grow.stdout, /2 → 4 universes/);
  for (const slot of ["uni-2", "uni-3"]) {
    const s = await stat(path.join(sb.projectRoot, ".worm", "universes", slot));
    assert.ok(s.isDirectory(), `${slot} should be created on grow`);
  }
  let state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots.length, 4);

  // Warp into uni-3 so shrinking past it is blocked.
  await sb.worm(["warp", "feature-a", "--skip-hook"]);                  // uni-0
  await sb.worm(["warp", "any-1", "--create", "--skip-hook"]);          // uni-1
  await sb.worm(["warp", "any-2", "--create", "--skip-hook"]);          // uni-2
  await sb.worm(["warp", "blocker", "--create", "--skip-hook"]);        // uni-3

  // Shrink: 4 → 2 should refuse because uni-2 and uni-3 are active.
  const shrinkFail = await sb.worm(["universes", "2"]);
  assert.notEqual(shrinkFail.exitCode, 0);
  assert.match(shrinkFail.stderr, /Cannot shrink/);
  assert.match(shrinkFail.stderr, /blocker/);

  // Collapse the two trailing slots, then shrink succeeds.
  await sb.worm(["collapse", "3", "--skip-hook"]);
  await sb.worm(["collapse", "2", "--skip-hook"]);
  const shrinkOk = await sb.worm(["universes", "2"]);
  assert.equal(shrinkOk.exitCode, 0, shrinkOk.stderr);
  assert.match(shrinkOk.stdout, /4 ← 2 universes/);

  state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots.length, 2);

  // Same-count is a no-op.
  const noop = await sb.worm(["universes", "2"]);
  assert.equal(noop.exitCode, 0, noop.stderr);
  assert.match(noop.stdout, /nothing to do/);

  // Junk input errors clearly.
  const bad = await sb.worm(["universes", "abc"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /not a valid universe count/);
});

test("default scripts/setup.sh is created and executable", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);
  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  const s = await stat(setupPath);
  // Owner exec bit (0o100) should be set after our chmod 0o755.
  assert.ok((s.mode & 0o100) !== 0, "setup.sh should be executable by owner");

  const contents = await readFile(setupPath, "utf8");
  assert.match(contents, /^#!\/usr\/bin\/env bash/);
});
