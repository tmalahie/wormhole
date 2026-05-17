import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { createBranch, createSandbox } from "./helpers.mjs";

test("worm init provisions the global root", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init"]);
  assert.equal(r.exitCode, 0, r.stderr);

  for (const rel of ["multiverses", "shared", "config.template.json", "shared/global-rules.md"]) {
    const s = await stat(path.join(sb.wormHome, rel));
    assert.ok(s, `expected ${rel} to exist`);
  }
});

test("worm register binds project, writes gitignore, is idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);
  const r1 = await sb.worm(["register", "--universes", "2"]);
  assert.equal(r1.exitCode, 0, r1.stderr);

  const configLink = await readlink(path.join(sb.projectRoot, ".worm", "config.json"));
  assert.match(configLink, /multiverses\/.+\/config\.json$/);

  for (const slot of ["uni-1", "uni-2"]) {
    const s = await stat(path.join(sb.projectRoot, ".worm", "universes", slot));
    assert.ok(s.isDirectory());
  }

  const gitignore = await readFile(path.join(sb.projectRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.worm\/$/m);

  const r2 = await sb.worm(["register", "--universes", "2"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /Reused global profile/);
});

test("warp mounts a branch with anchor + shared symlinks", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "2"]);

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

test("scan --json reflects slot states", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "2"]);
  await sb.worm(["warp", "feature-a", "--skip-hook"]);

  const r = await sb.worm(["scan", "--json"]);
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

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "1"]);
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

  const scan = await sb.worm(["scan", "--json"]);
  const state = JSON.parse(scan.stdout);
  assert.equal(state.slots[0].status, "STABLE");
});

test("warp into freed slot reuses uni-1 (anchors stay hot)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "2"]);
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

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "2"]);
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

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "2"]);
  await sb.worm(["warp", "a", "--skip-hook"]);

  const r = await sb.worm(["warp", "a", "--skip-hook"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /already active in slot uni-1/);
});

test("warp --create makes a new branch on the fly", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "1"]);

  const r = await sb.worm(["warp", "brand-new", "--skip-hook", "--create"]);
  assert.equal(r.exitCode, 0, r.stderr);
});

test("warp without --create fails clearly for unknown branch", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);
  await sb.worm(["register", "--universes", "1"]);

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

test("register outside a git repo errors with a hint", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  const empty = await mkdtemp(path.join(tmpdir(), "worm-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));

  const r = await sb.worm(["register"], { cwd: empty });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Not inside a git repository/);
});
