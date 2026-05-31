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

// Sibling pool worktree for slot N lives at `<root>-N`.
function siblingPath(root, n) {
  return `${root}-${n}`;
}

test("first `worm init` lazily provisions the global root", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init"]);
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

test("worm init binds Slot 0: symlinks, excludes .worm, seeds manifest, idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r1 = await sb.worm(["init"]);
  assert.equal(r1.exitCode, 0, r1.stderr);
  assert.match(r1.stdout, /bound to the Multiverse \(Slot 0\)/);

  const configLink = await readlink(path.join(sb.projectRoot, ".worm", "config.json"));
  assert.match(configLink, /multiverses\/.+\/config\.json$/);

  const scriptsLink = await readlink(path.join(sb.projectRoot, ".worm", "scripts"));
  assert.match(scriptsLink, /multiverses\/.+\/scripts$/);

  // .worm/ self-ignores AND is excluded locally from Slot 0's git view.
  const localIgnore = await readFile(path.join(sb.projectRoot, ".worm", ".gitignore"), "utf8");
  assert.equal(localIgnore.trim(), "*");
  const exclude = await readFile(path.join(sb.projectRoot, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.worm\/$/m);

  // Managed-link manifest is seeded.
  const manifest = JSON.parse(
    await readFile(path.join(sb.projectRoot, ".worm", ".managed-links.json"), "utf8")
  );
  assert.equal(typeof manifest, "object");

  const r2 = await sb.worm(["init"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /Reused global profile/);
  assert.doesNotMatch(r2.stdout, /First run/, "global init should not run twice");
});

test("worm init outside a git repo errors with a clone hint", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const empty = await mkdtemp(path.join(tmpdir(), "worm-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));

  const r = await sb.worm(["init"], { cwd: empty });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Not inside a git repository/);
  assert.match(r.stderr, /worm clone/);
});

test("worm clone makes a normal clone (no .bare) and binds it as Slot 0", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const cloneTarget = await mkdtemp(path.join(tmpdir(), "worm-clone-"));
  await rm(cloneTarget, { recursive: true, force: true });
  t.after(() => rm(cloneTarget, { recursive: true, force: true }));

  const r = await sb.worm(["clone", sb.seedRepo, cloneTarget], { cwd: tmpdir() });
  assert.equal(r.exitCode, 0, r.stderr);

  // Normal clone: .git is a directory, no .bare.
  const gitStat = await stat(path.join(cloneTarget, ".git"));
  assert.ok(gitStat.isDirectory(), ".git should be a directory (normal clone)");
  await assert.rejects(stat(path.join(cloneTarget, ".bare")), /ENOENT/, "no bare container");

  // .worm/ scaffolding got laid down.
  await stat(path.join(cloneTarget, ".worm", "config.json"));

  // Status works inside the clone — one slot (Slot 0).
  const status = await sb.worm(["status", "--json"], { cwd: cloneTarget });
  assert.equal(status.exitCode, 0, status.stderr);
  const state = JSON.parse(status.stdout);
  assert.equal(state.slots.length, 1);
  assert.equal(state.slots[0].isPrimary, true);

  // origin/main resolves inside the clone.
  const remoteHead = await execa("git", ["rev-parse", "origin/main"], { cwd: cloneTarget });
  assert.match(remoteHead.stdout, /^[0-9a-f]{40}$/);
});

test("worm universe add creates a sibling worktree; status shows the pool", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  const r = await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /Universe 1 is live/);

  const root = await realpath(sb.projectRoot);
  const sib = siblingPath(root, 1);
  const sibStat = await stat(sib);
  assert.ok(sibStat.isDirectory(), "sibling worktree should exist one level up");

  const state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots.length, 2);
  assert.equal(state.slots[0].index, 0);
  assert.equal(state.slots[0].name, "main");
  assert.equal(state.slots[0].isPrimary, true);
  assert.equal(state.slots[0].branch, "main");
  assert.equal(state.slots[1].index, 1);
  assert.equal(state.slots[1].name, "1");
  assert.equal(state.slots[1].branch, "feature-a");
  assert.equal(state.slots[1].path, sib);
});

test("shared_paths are linked into Slot 0 and each new universe", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [".env"], hooks: {} })
  );

  await sb.worm(["init", "--template", templateDir]);

  // Slot 0 gets a relative tunnel into .worm/shared.
  const slot0Link = await readlink(path.join(sb.projectRoot, ".env"));
  assert.equal(slot0Link, ".worm/shared/.env");

  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const sibLink = await readlink(path.join(siblingPath(root, 1), ".env"));
  assert.match(sibLink, /^\.\.\/.+\/\.worm\/shared\/\.env$/);
});

test("worm sync reconciles links and prunes removed shared_paths via the manifest", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [".env"], hooks: {} })
  );

  await sb.worm(["init", "--template", templateDir]);
  await stat(path.join(sb.projectRoot, ".env")); // link present

  // Drop .env from the config, then sync — the managed link should be pruned.
  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "multiverses", name, "config.json");
  await writeFile(cfgPath, JSON.stringify({ shared_paths: [], hooks: {} }));

  const r = await sb.worm(["sync"]);
  assert.equal(r.exitCode, 0, r.stderr);
  await assert.rejects(stat(path.join(sb.projectRoot, ".env")), /ENOENT/, "pruned link gone");

  // Idempotent.
  const r2 = await sb.worm(["sync"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
});

test("universe add refuses a branch already checked out in a slot", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);

  // `main` is checked out in Slot 0 → adding it as a universe is refused.
  const dupMain = await sb.worm(["universe", "add", "main", "--skip-hook"]);
  assert.notEqual(dupMain.exitCode, 0);
  assert.match(dupMain.stderr, /already checked out/);

  // After parking feature-a in a sibling, re-adding it is refused too.
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const dup = await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  assert.notEqual(dup.exitCode, 0);
  assert.match(dup.stderr, /already checked out/);
});

test("universe rm: protects Slot 0, refuses dirty without --force, --force discards", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const sib = siblingPath(root, 1);

  // Slot 0 is protected.
  const protectMain = await sb.worm(["universe", "rm", "0"]);
  assert.notEqual(protectMain.exitCode, 0);
  assert.match(protectMain.stderr, /Refusing to remove Slot 0/);

  // Make the sibling dirty.
  await writeFile(path.join(sib, "scratch.txt"), "wip\n");
  const refuse = await sb.worm(["universe", "rm", "1", "--skip-hook"]);
  assert.notEqual(refuse.exitCode, 0);
  assert.match(refuse.stderr, /uncommitted changes/);
  assert.match(refuse.stderr, /scratch\.txt/);
  await stat(sib); // still there

  // --force removes it.
  const ok = await sb.worm(["universe", "rm", "1", "--skip-hook", "--force"]);
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.match(ok.stderr, /Discarding 1 uncommitted change/);
  await assert.rejects(stat(sib), /ENOENT/);

  const state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots.length, 1);
});

test("universe rm accepts a branch name as well as an index", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);

  const r = await sb.worm(["universe", "rm", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots.length, 1);
});

test("worm switch changes the current slot in place; refuses a branch held elsewhere", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await createBranch(sb.projectRoot, "feature-b");

  await sb.worm(["init"]);

  // Switch Slot 0 main → feature-a in place.
  const r = await sb.worm(["switch", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);
  let state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots[0].branch, "feature-a");

  // Park feature-b in a sibling, then refuse to switch Slot 0 onto it.
  await sb.worm(["universe", "add", "feature-b", "--skip-hook"]);
  const blocked = await sb.worm(["switch", "feature-b", "--skip-hook"]);
  assert.notEqual(blocked.exitCode, 0);
  assert.match(blocked.stderr, /already checked out/);
});

test("on_create hook runs setup.sh with WORM_* env vars on universe add", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);

  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  await writeFile(
    setupPath,
    `#!/usr/bin/env bash\necho "ROOT=$WORM_PROJECT_ROOT"\necho "SLOT=$WORM_SLOT"\necho "INDEX=$WORM_SLOT_INDEX"\necho "BRANCH=$WORM_BRANCH"\necho "WT=$WORM_WORKTREE"\n`
  );
  await chmod(setupPath, 0o755);

  const r = await sb.worm(["universe", "add", "feature-a"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const root = await realpath(sb.projectRoot);
  assert.match(r.stdout, new RegExp(`ROOT=${escapeRegex(root)}`));
  assert.match(r.stdout, /SLOT=1/);
  assert.match(r.stdout, /INDEX=1/);
  assert.match(r.stdout, /BRANCH=feature-a/);
  assert.match(r.stdout, new RegExp(`WT=${escapeRegex(siblingPath(root, 1))}`));
});

test("init --template <dir> seeds config + scripts (new schema)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      shared_paths: [".envrc"],
      hooks: { on_create: "echo custom-template" },
    })
  );
  await mkdir(path.join(templateDir, "scripts"), { recursive: true });
  await writeFile(path.join(templateDir, "scripts", "setup.sh"), "#!/usr/bin/env bash\necho from-template\n");

  const r = await sb.worm(["init", "--template", templateDir]);
  assert.equal(r.exitCode, 0, r.stderr);

  const config = JSON.parse(await readFile(path.join(sb.projectRoot, ".worm", "config.json"), "utf8"));
  assert.deepEqual(config.shared_paths, [".envrc"]);
  assert.equal(config.hooks.on_create, "echo custom-template");

  const setup = await readFile(path.join(sb.projectRoot, ".worm", "scripts", "setup.sh"), "utf8");
  assert.match(setup, /from-template/);
});

test("init --template <missing> errors with a hint", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init", "--template", "/does/not/exist"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Template directory not found/);
});

test("legacy config (universes_count / anchors / on_warp) is tolerated on load", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);

  // Simulate a pre-Strategy-3 profile config.
  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "multiverses", name, "config.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      universes_count: 3,
      anchors: ["node_modules"],
      shared_paths: [],
      hooks: { on_warp: "echo hi", on_collapse: "echo bye" },
    })
  );

  // A command that loads config (sync) must not choke on the legacy shape.
  const r = await sb.worm(["sync"]);
  assert.equal(r.exitCode, 0, r.stderr);
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
  await assert.rejects(stat(path.join(sb.projectRoot, "fake-home", ".worm")), /ENOENT/);
});

test("commands resolve Slot 0 from inside a sibling worktree", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);

  const root = await realpath(sb.projectRoot);
  const r = await sb.worm(["status", "--json"], { cwd: siblingPath(root, 1) });
  assert.equal(r.exitCode, 0, r.stderr);
  const state = JSON.parse(r.stdout);
  assert.equal(state.slots.length, 2);
});

test("worm path resolves by branch and by slot index", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);

  const root = await realpath(sb.projectRoot);

  const byBranch = await sb.worm(["path", "feature-a"]);
  assert.equal(byBranch.exitCode, 0, byBranch.stderr);
  assert.equal(byBranch.stdout.trim(), siblingPath(root, 1));

  const byIndex0 = await sb.worm(["path", "0"]);
  assert.equal(byIndex0.stdout.trim(), root);

  const byIndex1 = await sb.worm(["path", "1"]);
  assert.equal(byIndex1.stdout.trim(), siblingPath(root, 1));

  const bad = await sb.worm(["path", "ghost-branch"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /No universe matches/);

  const oob = await sb.worm(["path", "99"]);
  assert.notEqual(oob.exitCode, 0);
  assert.match(oob.stderr, /No universe with index/);
});

test("worm completion emits per-shell scripts and rejects unknown shells", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const bash = await sb.worm(["completion", "bash"]);
  assert.equal(bash.exitCode, 0, bash.stderr);
  assert.match(bash.stdout, /^_worm_complete\(\) \{/m);
  assert.match(bash.stdout, /complete -F _worm_complete worm/);
  assert.match(bash.stdout, /init clone universe/);
  assert.match(bash.stdout, /git for-each-ref/);

  const zsh = await sb.worm(["completion", "zsh"]);
  assert.equal(zsh.exitCode, 0, zsh.stderr);
  assert.match(zsh.stdout, /compdef _worm_complete worm/);

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

  const empty = await sb.worm(["config", "editor"]);
  assert.equal(empty.exitCode, 0, empty.stderr);
  assert.match(empty.stdout, /\(unset\)/);

  const set = await sb.worm(["config", "editor", "code"]);
  assert.equal(set.exitCode, 0, set.stderr);

  const persisted = JSON.parse(await readFile(path.join(sb.wormHome, "config.json"), "utf8"));
  assert.equal(persisted.editor, "code");

  const get = await sb.worm(["config", "editor"]);
  assert.match(get.stdout, /^code$/m);

  const bad = await sb.worm(["config", "made-up-key"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /Unknown config key/);
});

test("worm destroy --force removes siblings, .worm/, and the global profile; Slot 0 survives", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--name", "demo"]);
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);

  const root = await realpath(sb.projectRoot);
  const sib = siblingPath(root, 1);
  await writeFile(path.join(sib, "scratch.txt"), "dirty\n");

  const r = await sb.worm(["destroy", "--force"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /multiverse is no more/);

  await assert.rejects(stat(path.join(sb.projectRoot, ".worm")), /ENOENT/);
  await assert.rejects(stat(sib), /ENOENT/, "sibling worktree removed");
  await assert.rejects(stat(path.join(sb.wormHome, "multiverses", "demo")), /ENOENT/);

  // Slot 0 itself (the repo + its .git) is untouched.
  const gitStat = await stat(path.join(sb.projectRoot, ".git"));
  assert.ok(gitStat.isDirectory(), "Slot 0's repo must survive destroy");
});

test("worm destroy without --force refuses in a non-interactive shell", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);
  const r = await sb.worm(["destroy"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /non-interactive/);
  assert.match(r.stderr, /--force/);
  await stat(path.join(sb.projectRoot, ".worm"));
});

test("worm destroy errors clearly when project isn't bound", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  // No `worm init` — no .worm/.

  const r = await sb.worm(["destroy", "--force"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /not bound/);
});

test("default scripts/setup.sh is created and executable", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);
  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  const s = await stat(setupPath);
  assert.ok((s.mode & 0o100) !== 0, "setup.sh should be executable by owner");
  const contents = await readFile(setupPath, "utf8");
  assert.match(contents, /^#!\/usr\/bin\/env bash/);
});
