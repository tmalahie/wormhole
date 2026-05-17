import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readlink, realpath, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
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

test("worm init binds project, writes self-contained gitignore, is idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r1 = await sb.worm(["init", "--universes", "2"]);
  assert.equal(r1.exitCode, 0, r1.stderr);

  const configLink = await readlink(path.join(sb.projectRoot, ".worm", "config.json"));
  assert.match(configLink, /multiverses\/.+\/config\.json$/);

  const scriptsLink = await readlink(path.join(sb.projectRoot, ".worm", "scripts"));
  assert.match(scriptsLink, /multiverses\/.+\/scripts$/);

  for (const slot of ["uni-1", "uni-2"]) {
    const s = await stat(path.join(sb.projectRoot, ".worm", "universes", slot));
    assert.ok(s.isDirectory());
  }

  // Ignore lives inside .worm/ — project root .gitignore is untouched.
  const localIgnore = await readFile(
    path.join(sb.projectRoot, ".worm", ".gitignore"),
    "utf8"
  );
  assert.equal(localIgnore.trim(), "*");
  await assert.rejects(
    stat(path.join(sb.projectRoot, ".gitignore")),
    /ENOENT/,
    "wormhole should not touch the project's root .gitignore"
  );

  const r2 = await sb.worm(["init", "--universes", "2"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /Reused global profile/);
  assert.doesNotMatch(r2.stdout, /First run/, "global init should not run twice");
});

test("warp mounts a branch with anchor + shared symlinks", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "2"]);

  const r = await sb.worm(["warp", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);

  const srcPath = path.join(sb.projectRoot, ".worm", "universes", "uni-1", "src");

  const anchor = await readlink(path.join(srcPath, "node_modules"));
  assert.equal(anchor, "../node_modules", "anchor should be a relative symlink");

  const sharedEnv = await readlink(path.join(srcPath, ".env"));
  assert.equal(sharedEnv, "../../../shared/.env");

  const srcStat = await stat(srcPath);
  assert.ok(srcStat.isDirectory());
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
  assert.equal(state.slots[0].name, "uni-1");
  assert.equal(state.slots[0].status, "ACTIVE");
  assert.equal(state.slots[0].branch, "feature-a");
  assert.equal(state.slots[1].name, "uni-2");
  assert.equal(state.slots[1].status, "STABLE");
});

test("collapse frees slot, keeps anchors warm, src removed", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "1"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  const r = await sb.worm(["collapse", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);

  const anchor = await stat(
    path.join(sb.projectRoot, ".worm", "universes", "uni-1", "node_modules")
  );
  assert.ok(anchor.isDirectory(), "node_modules anchor should survive collapse");

  await assert.rejects(
    stat(path.join(sb.projectRoot, ".worm", "universes", "uni-1", "src")),
    /ENOENT/,
    "src/ should be removed by collapse"
  );

  const status = await sb.worm(["status", "--json"]);
  const state = JSON.parse(status.stdout);
  assert.equal(state.slots[0].status, "STABLE");
});

test("warp into freed slot reuses uni-1 (anchors stay hot)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--universes", "2"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);
  await sb.worm(["collapse", "feature-a", "--skip-hook"]);

  const r = await sb.worm(["warp", "feature-a", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /uni-1/);
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
  assert.match(r.stderr, /already active in slot uni-1/);
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

test("init outside a git repo errors with a hint", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const empty = await mkdtemp(path.join(tmpdir(), "worm-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));

  const r = await sb.worm(["init"], { cwd: empty });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Not inside a git repository/);
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
  assert.match(r1.stdout, /SLOT=uni-1/);
  assert.match(r1.stdout, /INDEX=1/);
  assert.match(r1.stdout, /BRANCH=feature-a/);

  // Index advances with the slot — uni-2 should see INDEX=2.
  const r2 = await sb.worm(["warp", "feature-b"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /SLOT=uni-2/);
  assert.match(r2.stdout, /INDEX=2/);
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

  for (const slot of ["uni-1", "uni-2", "uni-3", "uni-4"]) {
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
