import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readlink, realpath, stat, lstat, writeFile, mkdir, chmod, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { execa } from "execa";
import { createBranch, createSandbox, PACKAGED_RECIPES } from "./helpers.mjs";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A linked worktree lives at `<root>/.claude/worktrees/<name>`.
function wtPath(root, name) {
  return path.join(root, ".claude", "worktrees", name);
}

test("first `worm init` lazily provisions the global root", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /First run/);

  for (const rel of [
    "projects",
    "shared",
    "shared/global-rules.md",
    "templates/default/config.json",
    "templates/default/scripts/setup.sh",
  ]) {
    const s = await stat(path.join(sb.wormHome, rel));
    assert.ok(s, `expected ${rel} to exist`);
  }
});

test("worm init binds the main worktree: symlinks, excludes .worm, seeds manifest, idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r1 = await sb.worm(["init"]);
  assert.equal(r1.exitCode, 0, r1.stderr);
  assert.match(r1.stdout, /is now bound \(main worktree:/);

  const configLink = await readlink(path.join(sb.projectRoot, ".worm", "config.json"));
  assert.match(configLink, /projects\/.+\/config\.json$/);

  const scriptsLink = await readlink(path.join(sb.projectRoot, ".worm", "scripts"));
  assert.match(scriptsLink, /projects\/.+\/scripts$/);

  // .worm/ self-ignores AND is excluded locally from Slot 0's git view.
  const localIgnore = await readFile(path.join(sb.projectRoot, ".worm", ".gitignore"), "utf8");
  assert.equal(localIgnore.trim(), "*");
  const exclude = await readFile(path.join(sb.projectRoot, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.worm\/$/m);

  // The profile carries a .gitignore so secrets (e.g. a shared .env) never get
  // committed to the personal ~/.worm repo. The repo's own files are untouched.
  const profileIgnore = await readFile(
    path.join(sb.wormHome, "projects", path.basename(sb.projectRoot), ".gitignore"),
    "utf8"
  );
  assert.match(profileIgnore, /^\.env$/m);
  await assert.rejects(
    stat(path.join(sb.projectRoot, ".gitignore")),
    /ENOENT/,
    "worm must not create a .gitignore in the user's actual repo"
  );

  // Managed-link manifest is seeded in the PROFILE (durable; survives a reclone).
  const manifest = JSON.parse(
    await readFile(
      path.join(sb.wormHome, "projects", path.basename(sb.projectRoot), ".managed-links.json"),
      "utf8"
    )
  );
  assert.equal(typeof manifest, "object");
  await assert.rejects(
    stat(path.join(sb.projectRoot, ".worm", ".managed-links.json")),
    /ENOENT/,
    "manifest no longer lives in local .worm/"
  );

  const r2 = await sb.worm(["init"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.match(r2.stdout, /Reused profile/);
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

test("worm clone makes a normal clone (no .bare) and binds it", async (t) => {
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

  // Status works inside the clone — one worktree, the main one.
  const status = await sb.worm(["status", "--json"], { cwd: cloneTarget });
  assert.equal(status.exitCode, 0, status.stderr);
  const state = JSON.parse(status.stdout);
  assert.equal(state.worktrees.length, 1);
  assert.equal(state.worktrees[0].isMain, true);

  // origin/main resolves inside the clone.
  const remoteHead = await execa("git", ["rev-parse", "origin/main"], { cwd: cloneTarget });
  assert.match(remoteHead.stdout, /^[0-9a-f]{40}$/);
});

test("worm worktree add creates .claude/worktrees/<name>, wired; ls/status show it", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  const r = await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const root = await realpath(sb.projectRoot);
  const wt = wtPath(root, "feature-a");
  assert.equal(r.stdout.trim().split("\n").pop(), wt, "the last stdout line is the path");
  assert.ok((await stat(wt)).isDirectory());
  // Wired: the keep marker Claude Desktop's GC respects.
  await stat(path.join(wt, ".worktree-keep"));
  // Neither the worktrees dir nor the marker shows up as untracked.
  const st = await execa("git", ["status", "--porcelain"], { cwd: root });
  assert.equal(st.stdout.trim(), "", "main worktree stays clean");
  const st2 = await execa("git", ["status", "--porcelain"], { cwd: wt });
  assert.doesNotMatch(st2.stdout, /worktree-keep/);

  const state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.worktrees.length, 2);
  assert.deepEqual(
    state.worktrees.map((w) => [w.name, w.isMain, w.branch, w.slot]),
    [["main", true, "main", null], ["feature-a", false, "feature-a", null]]
  );
  assert.equal(state.worktrees[1].path, wt);

  const ls = JSON.parse((await sb.worm(["worktree", "ls", "--json"])).stdout);
  assert.equal(ls[1].dirty, false);
  const lsText = await sb.worm(["worktree", "ls"]);
  assert.match(lsText.stdout, /feature-a/);
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

  // Slot 0 links straight at the profile source (absolute; the .worm/shared
  // two-hop is gone).
  const slot0Link = await readlink(path.join(sb.projectRoot, ".env"));
  assert.ok(path.isAbsolute(slot0Link), "slot links are absolute");
  assert.match(slot0Link, /projects\/.+\/\.env$/);

  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const root = await realpath(sb.projectRoot);
  const sibLink = await readlink(path.join(wtPath(root, "feature-a"), ".env"));
  assert.match(sibLink, /projects\/.+\/\.env$/);
  // No stale .worm/shared remains.
  await assert.rejects(stat(path.join(sb.projectRoot, ".worm", "shared")), /ENOENT/);
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
  const cfgPath = path.join(sb.wormHome, "projects", name, "config.json");
  await writeFile(cfgPath, JSON.stringify({ shared_paths: [], hooks: {} }));

  const r = await sb.worm(["sync"]);
  assert.equal(r.exitCode, 0, r.stderr);
  await assert.rejects(stat(path.join(sb.projectRoot, ".env")), /ENOENT/, "pruned link gone");

  // Idempotent.
  const r2 = await sb.worm(["sync"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
});

test("a `/*` shared_path links each child, keeps the parent real, and tracks adds/removes", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [".claude/skills/*"], hooks: {} })
  );

  // A skill committed to the REPO — the whole point of globbing: the slot's
  // .claude/skills/ must stay a real dir that can hold repo-tracked entries.
  const repoSkill = path.join(sb.projectRoot, ".claude", "skills", "committed");
  await mkdir(repoSkill, { recursive: true });
  await writeFile(path.join(repoSkill, "SKILL.md"), "in the repo\n");

  await sb.worm(["init", "--template", templateDir]);

  // Personal skills live in the profile; a dotfile must be skipped like a shell `*`.
  const name = path.basename(sb.projectRoot);
  const store = path.join(sb.wormHome, "projects", name, ".claude", "skills");
  await stat(store); // missing profile container was sprouted
  await mkdir(path.join(store, "daily"), { recursive: true });
  await writeFile(path.join(store, "daily", "SKILL.md"), "personal\n");
  await writeFile(path.join(store, ".DS_Store"), "junk");

  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const r = await sb.worm(["sync"]);
  assert.equal(r.exitCode, 0, r.stderr);

  const root = await realpath(sb.projectRoot);
  for (const slot of [root, wtPath(root, "feature-a")]) {
    const link = await readlink(path.join(slot, ".claude", "skills", "daily"));
    assert.match(link, /projects\/.+\/\.claude\/skills\/daily$/, "child is linked at the profile");
    // The container itself is a real dir, not a symlink.
    assert.equal(
      (await lstat(path.join(slot, ".claude", "skills"))).isSymbolicLink(),
      false,
      "the globbed parent stays a real directory"
    );
    await assert.rejects(
      stat(path.join(slot, ".claude", "skills", ".DS_Store")),
      /ENOENT/,
      "dot-prefixed children are skipped"
    );
  }
  // Slot 0's committed skill is untouched (it only exists there — siblings
  // branched before it was added).
  assert.equal((await readFile(path.join(repoSkill, "SKILL.md"), "utf8")), "in the repo\n");
  assert.equal((await lstat(repoSkill)).isSymbolicLink(), false);

  // A new child needs no config change; a removed one is pruned.
  await mkdir(path.join(store, "weekly"), { recursive: true });
  await writeFile(path.join(store, "weekly", "SKILL.md"), "personal\n");
  await rm(path.join(store, "daily"), { recursive: true, force: true });
  const r2 = await sb.worm(["sync"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  await readlink(path.join(root, ".claude", "skills", "weekly"));
  await assert.rejects(stat(path.join(root, ".claude", "skills", "daily")), /ENOENT/, "pruned");
});

test("a wildcard anywhere but the final segment is a clean config error", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [".claude/*/SKILL.md"], hooks: {} })
  );

  const r = await sb.worm(["init", "--template", templateDir]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr + r.stdout, /Unsupported wildcard/);
});

test("worm init adopts existing local files into the profile and creates symlinks", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  // Create a template that expects .mcp.json and .env as shared_paths
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [".mcp.json", ".env"], hooks: {} })
  );

  // Manually create local files (simulating an existing repo) before init
  await writeFile(path.join(sb.projectRoot, ".mcp.json"), '{"key":"local"}');
  await writeFile(path.join(sb.projectRoot, ".env"), "SECRET=local");

  // Init with the template — should adopt the existing local files
  const initResult = await sb.worm(["init", "--template", templateDir]);
  assert.equal(initResult.exitCode, 0, initResult.stderr);
  assert.match(initResult.stdout, /Adopting.*into the profile/);

  // Verify files are now symlinks pointing to the profile
  const mcpPath = path.join(sb.projectRoot, ".mcp.json");
  const envPath = path.join(sb.projectRoot, ".env");
  const mcpLink = await readlink(mcpPath);
  const envLink = await readlink(envPath);
  assert.match(mcpLink, /projects\/.+\/\.mcp\.json$/);
  assert.match(envLink, /projects\/.+\/\.env$/);

  // Verify file contents were preserved
  const mcpContent = await readFile(mcpPath, "utf8");
  const envContent = await readFile(envPath, "utf8");
  assert.equal(mcpContent, '{"key":"local"}');
  assert.equal(envContent, "SECRET=local");

  // Running sync should be a no-op (already adopted)
  const syncResult = await sb.worm(["sync"]);
  assert.equal(syncResult.exitCode, 0, syncResult.stderr);
  assert.doesNotMatch(syncResult.stdout, /move\+link/, "no adoption on second sync");
});

test("adoption pulls a whole directory shared_path into the profile, preserving contents", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [".claude"], hooks: {} })
  );

  // A real local directory (with a nested file) before init.
  await mkdir(path.join(sb.projectRoot, ".claude"), { recursive: true });
  await writeFile(path.join(sb.projectRoot, ".claude", "commands.md"), "# my command\n");

  const r = await sb.worm(["init", "--template", templateDir]);
  assert.equal(r.exitCode, 0, r.stderr);

  // The directory is now a symlink into the profile, contents intact.
  const claudeLink = await readlink(path.join(sb.projectRoot, ".claude"));
  assert.match(claudeLink, /projects\/.+\/\.claude$/);
  const nested = await readFile(path.join(sb.projectRoot, ".claude", "commands.md"), "utf8");
  assert.equal(nested, "# my command\n");

  // Re-running is a clean no-op (the slot path is already a symlink).
  const r2 = await sb.worm(["sync"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.doesNotMatch(r2.stdout, /move\+link/);
});

test("adoption refuses when a real file exists in BOTH the slot and the profile (conflict)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]); // default config: no shared_paths

  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "projects", name, "config.json");

  // A pre-existing profile copy AND a differing slot copy of the same path.
  await writeFile(path.join(sb.wormHome, "projects", name, "notes.md"), "PROFILE\n");
  await writeFile(path.join(sb.projectRoot, "notes.md"), "SLOT\n");
  await writeFile(cfgPath, JSON.stringify({ shared_paths: ["notes.md"], hooks: {} }));

  const r = await sb.worm(["sync", "--yes"]);
  assert.notEqual(r.exitCode, 0, "should refuse to clobber either copy");
  assert.match(r.stderr, /Cannot adopt/);
  assert.match(r.stderr, /differs from the profile/);

  // Nothing was moved: both copies are intact.
  assert.equal(await readFile(path.join(sb.projectRoot, "notes.md"), "utf8"), "SLOT\n");
  assert.equal(
    await readFile(path.join(sb.wormHome, "projects", name, "notes.md"), "utf8"),
    "PROFILE\n"
  );
});

test("adoption refuses when the same shared path is a real file in multiple slots", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await createBranch(sb.projectRoot, "feature-a");
  await sb.worm(["init"]);
  const add = await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  assert.equal(add.exitCode, 0, add.stderr);
  const root = await realpath(sb.projectRoot);

  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "projects", name, "config.json");
  await writeFile(cfgPath, JSON.stringify({ shared_paths: ["shared.txt"], hooks: {} }));

  // Two slots each hold a real, differing file at the same shared path.
  await writeFile(path.join(root, "shared.txt"), "slot0\n");
  await writeFile(path.join(wtPath(root, "feature-a"), "shared.txt"), "slot1\n");

  const r = await sb.worm(["sync", "--yes"]);
  assert.notEqual(r.exitCode, 0, "should refuse rather than silently overwrite one");
  assert.match(r.stderr, /multiple worktrees/);

  // Both copies survive untouched.
  assert.equal(await readFile(path.join(root, "shared.txt"), "utf8"), "slot0\n");
  assert.equal(await readFile(path.join(wtPath(root, "feature-a"), "shared.txt"), "utf8"), "slot1\n");
});

test("recipes: empty provisions nothing; sandbox generates Dockerfile + compose", async (t) => {
  // Default recipes are empty → no recipes dir.
  const sbNone = await createSandbox();
  t.after(() => sbNone.cleanup());
  await sbNone.worm(["init"]);
  // .worm/recipes is a symlink into the profile; with no recipes it resolves to
  // an empty dir, so assert no artifacts were materialized.
  await assert.rejects(
    stat(path.join(sbNone.projectRoot, ".worm", "recipes", "sandbox")),
    /ENOENT/,
    "no enabled recipe → no artifacts materialized"
  );

  // An enabled sandbox recipe generates artifacts under .worm/recipes/sandbox/.
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { sandbox: { tools: ["jq"] } } })
  );

  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const sandboxDir = path.join(sb.projectRoot, ".worm", "recipes", "sandbox");
  const dockerfile = await readFile(path.join(sandboxDir, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:22-bookworm/m);
  assert.match(dockerfile, /\bjq\b/);

  const compose = await readFile(path.join(sandboxDir, "compose.yml"), "utf8");
  const name = path.basename(sb.projectRoot);
  assert.match(compose, new RegExp(`name: ${escapeRegex(name)}-sandbox`));
  assert.match(compose, /\$\{SANDBOX_DIR/, "mount comes from $SANDBOX_DIR at run time");
  assert.doesNotMatch(compose, /\/Users\//, "no hardcoded home path leaks into the generated compose");
});

test("sandbox wiring installs the static dispatcher entry; container is computed fresh per worktree", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { sandbox: {} } })
  );

  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await sb.worm(["init", "--template", templateDir]);

  const name = path.basename(await realpath(sb.projectRoot));
  const sandboxDir = path.join(sb.projectRoot, ".worm", "recipes", "sandbox");
  const readLocal = async (dir) =>
    JSON.parse(await readFile(path.join(dir, ".claude", "settings.local.json"), "utf8"));

  // Policy materialized; interceptor code is live-once (not copied) — from inc1.
  await assert.rejects(stat(path.join(sandboxDir, "redirect-to-sandbox.js")), /ENOENT/);
  const policy = JSON.parse(await readFile(path.join(sandboxDir, "sandbox-policy.json"), "utf8"));
  assert.ok(Array.isArray(policy.neverSandbox));

  // settings.local.json holds ONE static dispatcher entry per event — no
  // per-recipe command, no container name baked in (that's computed at trigger).
  const s0 = await readLocal(sb.projectRoot);
  assert.equal(s0.hooks.PreToolUse.length, 1);
  assert.equal(s0.hooks.PreToolUse[0].matcher, "Bash");
  assert.match(s0.hooks.PreToolUse[0].hooks[0].command, /hook trigger pre-tool-use/);
  assert.doesNotMatch(
    s0.hooks.PreToolUse[0].hooks[0].command,
    /sandbox|redirect-to-sandbox/,
    "no per-recipe detail leaks into settings"
  );
  assert.match(s0.hooks.SessionStart[0].hooks[0].command, /hook trigger session-start/);

  // The container name is produced at TRIGGER time: deny a destructive command
  // and read it from the interceptor's decision. Slot 0 → <name>-main-sandbox.
  const denyIn = JSON.stringify({ tool_input: { command: "rm -rf /tmp/zzz" } });
  const d0 = await sb.worm(["hook", "trigger", "pre-tool-use"], { input: denyIn });
  assert.match(d0.stdout, /"permissionDecision":"deny"/);
  assert.match(d0.stdout, new RegExp(`${escapeRegex(name)}-main-sandbox`));

  // A linked worktree computes its OWN container name (from its name) from the SAME dispatcher entry.
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const root = await realpath(sb.projectRoot);
  const s1 = await readLocal(wtPath(root, "feature-a"));
  assert.match(s1.hooks.PreToolUse[0].hooks[0].command, /hook trigger pre-tool-use/);
  const d1 = await sb.worm(["hook", "trigger", "pre-tool-use"], {
    cwd: wtPath(root, "feature-a"),
    input: denyIn,
  });
  assert.match(d1.stdout, new RegExp(`${escapeRegex(name)}-feature-a-sandbox`));

  // Idempotent: a re-sync must not duplicate the dispatcher entry.
  await sb.worm(["sync"]);
  const s0b = await readLocal(sb.projectRoot);
  assert.equal(s0b.hooks.PreToolUse.length, 1, "re-sync must not duplicate the dispatcher entry");
});

test("syncPermissions wires session dispatcher entries and runs through the dispatcher", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { syncPermissions: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  // No artifacts dir, and settings hold the static session dispatcher entries —
  // no per-recipe command, no canonical path baked in (computed at trigger).
  await assert.rejects(stat(path.join(sb.projectRoot, ".worm", "recipes", "syncPermissions")), /ENOENT/);
  const s0 = JSON.parse(
    await readFile(path.join(sb.projectRoot, ".claude", "settings.local.json"), "utf8")
  );
  assert.equal(s0.hooks.SessionStart.length, 1);
  assert.match(s0.hooks.SessionStart[0].hooks[0].command, /hook trigger session-start/);
  assert.equal(s0.hooks.SessionEnd.length, 1);
  assert.match(s0.hooks.SessionEnd[0].hooks[0].command, /hook trigger session-end/);
  assert.ok(!s0.hooks.PreToolUse, "syncPermissions contributes no filter (PreToolUse) entry");

  // Triggering session-start through the dispatcher unions the slot's permissions
  // with the canonical global-profile store (hermetic — pure node, no docker).
  const canonical = path.join(
    sb.wormHome, "projects", path.basename(await realpath(sb.projectRoot)), ".claude", "settings.local.json"
  );
  await mkdir(path.dirname(canonical), { recursive: true });
  await writeFile(canonical, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  const localFile = path.join(sb.projectRoot, ".claude", "settings.local.json");
  const cur = JSON.parse(await readFile(localFile, "utf8"));
  cur.permissions = { allow: ["Bash(git status:*)"] };
  await writeFile(localFile, JSON.stringify(cur));

  await sb.worm(["hook", "trigger", "session-start"]);

  const merged = JSON.parse(await readFile(localFile, "utf8"));
  assert.deepEqual(
    new Set(merged.permissions.allow),
    new Set(["Bash(ls:*)", "Bash(git status:*)"]),
    "dispatcher ran syncPermissions: slot ∪ canonical"
  );
  assert.ok(merged.hooks.SessionStart, "the dispatcher entry itself is left intact");
});

test("recipes compose: sandbox + syncPermissions share ONE dispatcher entry per event", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { sandbox: {}, syncPermissions: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const readLocal = async () =>
    JSON.parse(await readFile(path.join(sb.projectRoot, ".claude", "settings.local.json"), "utf8"));

  const s0 = await readLocal();
  // Inversion: a SINGLE static entry per event, regardless of how many recipes
  // contribute. session-start routes to BOTH recipes at trigger time.
  assert.equal(s0.hooks.PreToolUse.length, 1, "one filter dispatcher (sandbox)");
  assert.match(s0.hooks.PreToolUse[0].hooks[0].command, /hook trigger pre-tool-use/);
  assert.equal(s0.hooks.SessionStart.length, 1, "single dispatcher entry, not one per recipe");
  assert.match(s0.hooks.SessionStart[0].hooks[0].command, /hook trigger session-start/);
  assert.equal(s0.hooks.SessionEnd.length, 1);
  assert.match(s0.hooks.SessionEnd[0].hooks[0].command, /hook trigger session-end/);

  // Idempotent: re-sync must not duplicate the dispatcher entries.
  await sb.worm(["sync"]);
  const s0b = await readLocal();
  assert.equal(s0b.hooks.SessionStart.length, 1, "re-sync must not duplicate");
  assert.equal(s0b.hooks.PreToolUse.length, 1);
});

test("worm sync preserves a user's own hooks and never duplicates its dispatcher entry", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { sandbox: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  // Add a user's own PreToolUse hook alongside worm's dispatcher entry.
  const localFile = path.join(sb.projectRoot, ".claude", "settings.local.json");
  const s0 = JSON.parse(await readFile(localFile, "utf8"));
  s0.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "echo keep-me" }] });
  await writeFile(localFile, JSON.stringify(s0));

  await sb.worm(["sync"]);

  const after = JSON.parse(await readFile(localFile, "utf8"));
  const cmds = after.hooks.PreToolUse.map((e) => e.hooks[0].command);
  assert.ok(cmds.includes("echo keep-me"), "user's own hook is preserved across re-wiring");
  assert.equal(
    cmds.filter((c) => c.includes("hook trigger")).length,
    1,
    "worm's dispatcher entry is not duplicated"
  );
  assert.equal(after.hooks.PreToolUse.length, 2, "user hook + one worm hook");
});

test("syncPermissions script unions permissions while preserving other keys", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { syncPermissions: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const script = path.join(PACKAGED_RECIPES, "syncPermissions", "sync-claude-settings.js");
  // Canonical store is just a fixture file here; put it somewhere that exists
  // (syncPermissions no longer materializes a .worm/recipes/ dir).
  const canonical = path.join(sb.projectRoot, ".worm", "permissions.json");

  // Canonical store already holds one allow rule…
  await writeFile(canonical, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  // …and this slot has a DIFFERENT rule plus a hooks block (another recipe's).
  const localFile = path.join(sb.projectRoot, ".claude", "settings.local.json");
  await mkdir(path.dirname(localFile), { recursive: true });
  await writeFile(
    localFile,
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep-me" }] }] },
      permissions: { allow: ["Bash(git status:*)"] },
    })
  );

  const base = path.join(sb.projectRoot, ".worm", "permissions.base.json"); // no base yet → union
  const run = await execa("node", [script, canonical, base], {
    cwd: sb.projectRoot,
    env: { ...process.env, CLAUDE_PROJECT_DIR: sb.projectRoot },
    reject: false,
  });
  assert.equal(run.exitCode, 0, run.stderr);

  const merged = JSON.parse(await readFile(localFile, "utf8"));
  assert.deepEqual(
    new Set(merged.permissions.allow),
    new Set(["Bash(ls:*)", "Bash(git status:*)"]),
    "permissions unioned across slot + canonical"
  );
  assert.equal(
    merged.hooks.PreToolUse[0].hooks[0].command,
    "echo keep-me",
    "another recipe's hooks block is preserved, not clobbered"
  );
  const canonAfter = JSON.parse(await readFile(canonical, "utf8"));
  assert.deepEqual(
    new Set(canonAfter.permissions.allow),
    new Set(["Bash(ls:*)", "Bash(git status:*)"])
  );
});

test("syncPermissions propagates a revoked rule instead of resurrecting it (3-way base)", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { syncPermissions: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const canonical = path.join(
    sb.wormHome, "projects", path.basename(await realpath(sb.projectRoot)), ".claude", "settings.local.json"
  );
  await mkdir(path.dirname(canonical), { recursive: true });
  await writeFile(canonical, JSON.stringify({ permissions: { allow: ["Bash(ls:*)", "Bash(rm:*)"] } }));
  const localFile = path.join(sb.projectRoot, ".claude", "settings.local.json");

  // First sync establishes the base: both sides agree on the two rules.
  await sb.worm(["hook", "trigger", "session-start"]);
  const seeded = JSON.parse(await readFile(localFile, "utf8"));
  assert.deepEqual(new Set(seeded.permissions.allow), new Set(["Bash(ls:*)", "Bash(rm:*)"]));

  // The user revokes one rule in the slot. The old union-only merge pulled it
  // straight back from canonical; the 3-way merge must propagate the removal.
  seeded.permissions.allow = ["Bash(ls:*)"];
  await writeFile(localFile, JSON.stringify(seeded));
  await sb.worm(["hook", "trigger", "session-start"]);

  const after = JSON.parse(await readFile(localFile, "utf8"));
  const canonAfter = JSON.parse(await readFile(canonical, "utf8"));
  assert.deepEqual(after.permissions.allow, ["Bash(ls:*)"], "revoked rule is not resurrected");
  assert.deepEqual(canonAfter.permissions.allow, ["Bash(ls:*)"], "removal propagated to canonical");
  assert.ok(after.hooks.SessionStart, "worm's own dispatcher entry is untouched");
});

const claudeSlug = (p) => p.replace(/[/.]/g, "-");

test("a worktree's Claude project dir is linked to the main worktree's", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { shareHistory: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await sb.worm(["init", "--template", templateDir]); // HOME=wormHome in the harness

  const root = await realpath(sb.projectRoot);
  const projectsDir = path.join(sb.wormHome, ".claude", "projects");

  // The main worktree's dir is the canonical store — never a self-symlink.
  await assert.rejects(
    stat(path.join(projectsDir, claudeSlug(root))),
    /ENOENT/,
    "main is not self-linked"
  );

  // A linked worktree's dir becomes a relative symlink to the main worktree's slug.
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const link = path.join(projectsDir, claudeSlug(wtPath(root, "feature-a")));
  assert.equal(await readlink(link), claudeSlug(root), "relative symlink → main slug");
});

test("a real Claude project dir for a new worktree is left alone, with a warning", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { shareHistory: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-b");
  await sb.worm(["init", "--template", templateDir]);

  const root = await realpath(sb.projectRoot);
  const realDir = path.join(sb.wormHome, ".claude", "projects", claudeSlug(wtPath(root, "feature-b")));
  await mkdir(realDir, { recursive: true });
  await writeFile(path.join(realDir, "session.jsonl"), "{}\n");

  const r = await sb.worm(["worktree", "add", "feature-b", "--no-setup"]);
  assert.equal(r.exitCode, 0, "real dir is a warning, not a fatal error");
  // The real dir and its contents survive untouched.
  await stat(path.join(realDir, "session.jsonl"));
  assert.match(r.stderr, /is a real directory — merge it/);
});

test("shareHistory warns on a cwd switch via a UserPromptSubmit hook", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { shareHistory: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  // Slot 0 gets a static UserPromptSubmit dispatcher entry (no matcher).
  const s0 = JSON.parse(
    await readFile(path.join(sb.projectRoot, ".claude", "settings.local.json"), "utf8")
  );
  assert.match(s0.hooks.UserPromptSubmit[0].hooks[0].command, /hook trigger user-prompt-submit/);

  // A transcript whose last entry has a DIFFERENT cwd → the dispatcher emits the
  // UserPromptSubmit envelope with a worktree-switch reminder.
  const transcript = path.join(sb.wormHome, "transcript.jsonl");
  const prevCwd = wtPath(sb.projectRoot, "feature-b");
  await writeFile(
    transcript,
    JSON.stringify({ type: "user", cwd: prevCwd, message: { content: "earlier" } }) + "\n"
  );
  const input = JSON.stringify({ cwd: sb.projectRoot, transcript_path: transcript, prompt: "now" });
  const r = await sb.worm(["hook", "trigger", "user-prompt-submit"], { input });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /working directory switched/);
  assert.match(
    out.hookSpecificOutput.additionalContext,
    new RegExp(escapeRegex(sb.projectRoot))
  );

  // Unchanged cwd → silent (no context injected).
  const same = JSON.stringify({ cwd: prevCwd, transcript_path: transcript, prompt: "again" });
  const r2 = await sb.worm(["hook", "trigger", "user-prompt-submit"], { input: same });
  assert.equal(r2.stdout.trim(), "", "no reminder when cwd is unchanged");
});

test("shareMemory seeds the profile and links every slot's memory at it", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { shareMemory: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  const root = await realpath(sb.projectRoot);
  const name = path.basename(root);
  const projectsDir = path.join(sb.wormHome, ".claude", "projects");
  const profileMemory = path.join(sb.wormHome, "projects", name, ".claude", "memory");

  // A pre-existing real memory dir at Slot 0 is migrated into the profile store.
  const slot0Memory = path.join(projectsDir, claudeSlug(root), "memory");
  await mkdir(slot0Memory, { recursive: true });
  await writeFile(path.join(slot0Memory, "MEMORY.md"), "remember\n");

  await sb.worm(["init", "--template", templateDir]);

  // Seeded into the profile, and Slot 0's memory is now an absolute symlink to it.
  assert.equal(await readFile(path.join(profileMemory, "MEMORY.md"), "utf8"), "remember\n");
  assert.equal(await readlink(slot0Memory), profileMemory, "Slot 0 memory → profile (absolute)");

  // A sibling's memory dir is linked at the SAME profile store, so memory is shared.
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const sibMemory = path.join(projectsDir, claudeSlug(wtPath(root, "feature-a")), "memory");
  assert.equal(await readlink(sibMemory), profileMemory, "sibling memory → profile");
});

test("shareMemory refuses to clobber a real memory dir when the profile store exists", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { shareMemory: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-b");

  const root = await realpath(sb.projectRoot);
  // init links Slot 0 → the (now-existing) profile store; a sibling that already
  // has a REAL memory dir can no longer be seeded into it, so it must be skipped.
  await sb.worm(["init", "--template", templateDir]);

  const sibReal = path.join(
    sb.wormHome, ".claude", "projects", claudeSlug(wtPath(root, "feature-b")), "memory"
  );
  await mkdir(sibReal, { recursive: true });
  await writeFile(path.join(sibReal, "keep.md"), "x\n");

  const r = await sb.worm(["worktree", "add", "feature-b", "--no-setup"]);
  assert.equal(r.exitCode, 0, "real dir is a warning, not a fatal error");
  await stat(path.join(sibReal, "keep.md")); // the real dir and its contents survive
  assert.match(r.stderr + r.stdout, /real memory dir/);
});

test("the dispatcher logs recipe hooks under .worm/logs", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  // autostart off so triggering session-start never spawns docker — the run-hook
  // logging is exercised by syncPermissions (pure node) instead.
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      shared_paths: [],
      hooks: {},
      recipes: { sandbox: { autostart: false }, syncPermissions: {} },
    })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const root = await realpath(sb.projectRoot); // init canonicalizes via realpath
  const name = path.basename(root);
  const container = `${name}-main-sandbox`;
  const logsDir = path.join(root, ".worm", "logs");

  // init pre-creates the log dir so the dispatcher's `>>` redirect can't fail.
  assert.equal((await stat(logsDir)).isDirectory(), true);

  // Filter event: the dispatcher sets $WORM_LOG_DIR, so the interceptor self-logs
  // its DENY decision to <container>-redirect.log (pure node, hermetic).
  await sb.worm(["hook", "trigger", "pre-tool-use"], {
    input: JSON.stringify({ tool_input: { command: "rm -rf /tmp/zzz" } }),
  });
  const redirectLog = await readFile(path.join(logsDir, `${container}-redirect.log`), "utf8");
  assert.match(redirectLog, /DENY .*rm -rf \/tmp\/zzz/);

  // Run event: the dispatcher captures the command's output under a dated banner
  // to <recipe>.log — present regardless of what the command does.
  await sb.worm(["hook", "trigger", "session-start"]);
  const sessionLog = await readFile(path.join(logsDir, "syncPermissions.log"), "utf8");
  assert.match(sessionLog, /=== .* session-start ===/);
});

test("sandbox interceptor: node code runs are sandboxed; npm and node --check are not", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { sandbox: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const sandboxDir = path.join(sb.projectRoot, ".worm", "recipes", "sandbox");
  // The interceptor is worm-owned code shipped with the binary; the project's
  // policy file is passed as an arg (exactly as the generated hook does).
  const interceptor = path.join(PACKAGED_RECIPES, "sandbox", "redirect-to-sandbox.js");
  const policyFile = path.join(sandboxDir, "sandbox-policy.json");
  const decide = async (command) => {
    const r = await execa("node", [interceptor, "c", "/x/compose.yml", policyFile], {
      input: JSON.stringify({ tool_input: { command } }),
      reject: false,
    });
    return r.stdout.includes('"permissionDecision":"deny"') ? "deny" : "allow";
  };

  assert.equal(await decide("node scripts/test.js"), "deny", "node <script> runs arbitrary code");
  assert.equal(await decide("node --check scripts/test.js"), "allow", "syntax check executes nothing");
  assert.equal(await decide("node --version"), "allow");
  assert.equal(await decide("npm install"), "allow", "npm stays exempt (host node_modules)");
  assert.equal(await decide("rm -rf /tmp/x"), "deny");

  // Operators / file-op words INSIDE quotes must not be misread as command
  // boundaries — commit messages, --body text, echo, etc. (regression).
  assert.equal(await decide('git commit -m "oops; rm cruft"'), "allow", "; inside a quote is not a split");
  assert.equal(await decide('echo "a || cp b"'), "allow", "|| inside a quote is not a split");
  assert.equal(await decide('gh pr comment --body "see; rm note"'), "allow");
  assert.equal(await decide('git commit -m "fix .worm/x bug"'), "allow", "quoted .worm path is just text");
  // …but real, unquoted operators still expose the trailing file-op.
  assert.equal(await decide("git status && rm -rf build"), "deny", "unquoted && still splits");
  assert.equal(await decide('echo hi; rm -rf build'), "deny", "unquoted ; still splits");
  // Dir-exemption is per-segment: it can't shield a sibling file-op.
  assert.equal(await decide("bash .worm/scripts/x.sh"), "allow", "scripts under .worm stay on host");
  assert.equal(await decide("cat .worm/x && rm -rf build"), "deny", "exempt clause can't shield the rm");
  // Quoted script PATHS are still caught (raw segment keeps them visible).
  assert.equal(await decide('bash "deploy.sh"'), "deny", "quoted script path still sandboxed");

  // The generated policy no longer exempts node.
  const policy = JSON.parse(await readFile(path.join(sandboxDir, "sandbox-policy.json"), "utf8"));
  assert.ok(!policy.neverSandbox.includes("node"), "node dropped from neverSandbox default");
  assert.ok(policy.neverSandbox.includes("npm"), "npm still exempt");
});

test("worktree add refuses a branch already checked out elsewhere", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);

  // `main` is the main worktree's branch → refused, with a hint about it.
  const dupMain = await sb.worm(["worktree", "add", "main", "--no-setup"]);
  assert.notEqual(dupMain.exitCode, 0);
  assert.match(dupMain.stderr, /already checked out/);
  assert.match(dupMain.stderr, /main worktree stays on main/);

  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const dup = await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  assert.notEqual(dup.exitCode, 0);
  assert.match(dup.stderr, /already checked out/);
});

test("worktree add on a missing branch creates it from origin/<baseBranch>, untracked", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  const r = await sb.worm(["worktree", "add", "feat/new", "--no-setup"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const root = await realpath(sb.projectRoot);
  const wt = wtPath(root, "new"); // name = the branch's last segment
  assert.ok((await stat(wt)).isDirectory());
  const head = await execa("git", ["rev-parse", "HEAD"], { cwd: wt });
  const base = await execa("git", ["rev-parse", "origin/main"], { cwd: root });
  assert.equal(head.stdout, base.stdout, "cut from origin/main");
  const upstream = await execa("git", ["rev-parse", "--abbrev-ref", "feat/new@{upstream}"], {
    cwd: wt,
    reject: false,
  });
  assert.notEqual(upstream.exitCode, 0, "a new branch does not track origin/main");

  // Same last segment again → a distinct directory.
  const again = await sb.worm(["worktree", "add", "fix/new", "--no-setup"]);
  assert.equal(again.exitCode, 0, again.stderr);
  await stat(wtPath(root, "new-2"));
});

test("worktree add keeps a checkout whose post-checkout hook fails (husky before install)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  // husky's layout: a relative hooksPath whose hook sources a file the new
  // worktree only gets from its own install — so the hook fails there.
  const hooks = path.join(sb.projectRoot, ".hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, "post-checkout"), '#!/bin/sh\n. "$(dirname "$0")/h"\n', { mode: 0o755 });
  await execa("git", ["config", "core.hooksPath", ".hooks"], { cwd: sb.projectRoot });
  await sb.worm(["init"]);

  const r = await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stderr, /post-checkout hook failed/);
  const wt = wtPath(await realpath(sb.projectRoot), "feature-a");
  await stat(path.join(wt, ".worktree-keep"));
});

test("worktree rm: protects main, refuses dirty without --force, cleans up after itself", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const root = await realpath(sb.projectRoot);
  const wt = wtPath(root, "feature-a");
  await sb.worm(["slot", "assign", "feature-a"]);
  const name = path.basename(sb.projectRoot);
  const baseFile = path.join(sb.wormHome, "projects", name, ".sync-permissions.base.feature-a.json");
  await writeFile(baseFile, "{}");
  const slugLink = path.join(sb.wormHome, ".claude", "projects", claudeSlug(wt));
  assert.ok((await lstat(slugLink)).isSymbolicLink(), "worktree's Claude dir → main's");

  const protectMain = await sb.worm(["worktree", "rm", "main"]);
  assert.notEqual(protectMain.exitCode, 0);
  assert.match(protectMain.stderr, /Refusing to remove the main worktree/);

  await writeFile(path.join(wt, "scratch.txt"), "wip\n");
  const refuse = await sb.worm(["worktree", "rm", "feature-a"]);
  assert.notEqual(refuse.exitCode, 0);
  assert.match(refuse.stderr, /uncommitted changes/);
  assert.match(refuse.stderr, /scratch\.txt/);
  await stat(wt);

  const ok = await sb.worm(["worktree", "rm", "feature-a", "--force"]);
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.match(ok.stdout, /released slot 0/);
  assert.match(ok.stdout, /kept branch feature-a/);
  await assert.rejects(stat(wt), /ENOENT/);
  await assert.rejects(lstat(slugLink), /ENOENT/, "Claude dir link removed");
  await assert.rejects(stat(baseFile), /ENOENT/, "syncPermissions base file removed");
  const slots = JSON.parse((await sb.worm(["slot", "ls", "--json"])).stdout);
  assert.equal(slots.slots[0].worktree, null, "slot 0 is free again");
  const state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.worktrees.length, 1);
});

test("worktree rm accepts a branch, and --delete-branch deletes a merged branch", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);

  const r = await sb.worm(["worktree", "rm", "feature-a", "--delete-branch"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const branches = await execa("git", ["branch", "--list", "feature-a"], { cwd: sb.projectRoot });
  assert.equal(branches.stdout.trim(), "", "merged branch deleted");
});

test("worm cd without shell-init explains how to enable it", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  // When the shell function is installed it intercepts cd before the binary;
  // reaching the binary means the integration is missing → a helpful error.
  const r = await sb.worm(["cd", "main"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /shell integration/);
  assert.match(r.stderr, /worm shell-init/);
});

test("on_create runs setup.sh with WORM_* env vars on worktree add (no slot yet)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);

  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  await writeFile(
    setupPath,
    `#!/usr/bin/env bash\necho "ROOT=$WORM_PROJECT_ROOT"\necho "SLOT=[$WORM_SLOT]"\necho "NAME=$WORM_WORKTREE_NAME"\necho "BRANCH=$WORM_BRANCH"\necho "WT=$WORM_WORKTREE"\necho "PROFILE=$WORM_PROFILE"\n`
  );
  await chmod(setupPath, 0o755);

  const r = await sb.worm(["worktree", "add", "feature-a"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const root = await realpath(sb.projectRoot);
  assert.match(r.stdout, new RegExp(`ROOT=${escapeRegex(root)}`));
  assert.match(r.stdout, /SLOT=\[\]/, "no slot on creation");
  assert.match(r.stdout, /NAME=feature-a/);
  assert.match(r.stdout, /BRANCH=feature-a/);
  assert.match(r.stdout, new RegExp(`WT=${escapeRegex(wtPath(root, "feature-a"))}`));
  const profile = path.join(sb.wormHome, "projects", path.basename(sb.projectRoot));
  assert.match(r.stdout, new RegExp(`PROFILE=${escapeRegex(profile)}`));
});

test("on_create sets up the main worktree on init; --skip-hook opts out", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);

  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  await writeFile(
    setupPath,
    `#!/usr/bin/env bash\necho "ROOT=$WORM_PROJECT_ROOT"\necho "NAME=$WORM_WORKTREE_NAME"\necho "BRANCH=$WORM_BRANCH"\necho "WT=$WORM_WORKTREE"\n`
  );
  await chmod(setupPath, 0o755);

  // Re-running init is the "create" event for the main worktree.
  const r = await sb.worm(["init", "--force"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const root = await realpath(sb.projectRoot);
  assert.match(r.stdout, new RegExp(`ROOT=${escapeRegex(root)}`));
  assert.match(r.stdout, /NAME=main/);
  assert.match(r.stdout, /BRANCH=main/);
  assert.match(r.stdout, new RegExp(`WT=${escapeRegex(root)}`));

  const skipped = await sb.worm(["init", "--force", "--skip-hook"]);
  assert.equal(skipped.exitCode, 0, skipped.stderr);
  assert.doesNotMatch(skipped.stdout, /NAME=main/);
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

test("config is strict: legacy keys are rejected, not silently migrated", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "projects", name, "config.json");

  // A pre-Strategy-3 / pre-recipes shape. With back-compat removed, loading this
  // must fail loudly (single-user project — no legacy normalizer).
  await writeFile(
    cfgPath,
    JSON.stringify({
      universes_count: 3,
      anchors: ["node_modules"],
      shared_paths: [],
      hooks: { on_warp: "echo hi" },
      sandbox: { recipe: "docker" },
    })
  );

  const r = await sb.worm(["sync"]);
  assert.notEqual(r.exitCode, 0, "strict schema must reject unknown legacy keys");
  assert.match(r.stderr, /Invalid config/);
});

test("WORM_HOME takes precedence over HOME", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r = await sb.worm(["init"], {
    home: path.join(sb.projectRoot, "fake-home"),
    wormHome: sb.wormHome,
  });
  assert.equal(r.exitCode, 0, r.stderr);

  await stat(path.join(sb.wormHome, "projects"));
  await assert.rejects(stat(path.join(sb.projectRoot, "fake-home", ".worm")), /ENOENT/);
});

test("commands resolve the project from inside a linked worktree", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);

  const root = await realpath(sb.projectRoot);
  const r = await sb.worm(["status", "--json"], { cwd: wtPath(root, "feature-a") });
  assert.equal(r.exitCode, 0, r.stderr);
  const state = JSON.parse(r.stdout);
  assert.equal(state.worktrees.length, 2);
  assert.equal(state.root, root);
});

test("worm path resolves by name, branch and slot number", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feat/a");

  await sb.worm(["init"]);
  await sb.worm(["worktree", "add", "feat/a", "--no-setup"]);
  const root = await realpath(sb.projectRoot);
  const wt = wtPath(root, "a");

  assert.equal((await sb.worm(["path", "a"])).stdout.trim(), wt, "by name");
  assert.equal((await sb.worm(["path", "feat/a"])).stdout.trim(), wt, "by branch");
  assert.equal((await sb.worm(["path", "main"])).stdout.trim(), root, "main");
  assert.equal((await sb.worm(["worktree", "path", "a"])).stdout.trim(), wt, "worktree path");

  await sb.worm(["slot", "assign", "a", "3"]);
  assert.equal((await sb.worm(["path", "3"])).stdout.trim(), wt, "by slot number");

  const bad = await sb.worm(["path", "ghost-branch"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /No worktree matches/);

  const free = await sb.worm(["path", "5"]);
  assert.notEqual(free.exitCode, 0);
  assert.match(free.stderr, /No worktree holds slot 5/);
});

test("worm completion emits per-shell scripts and rejects unknown shells", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const bash = await sb.worm(["completion", "bash"]);
  assert.equal(bash.exitCode, 0, bash.stderr);
  assert.match(bash.stdout, /^_worm_complete\(\) \{/m);
  assert.match(bash.stdout, /complete -F _worm_complete worm/);
  assert.match(bash.stdout, /init clone worktree slot/);
  assert.match(bash.stdout, /\.claude\/worktrees/);

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

test("worm destroy --force removes linked worktrees, .worm/, and the profile; main survives", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init", "--name", "demo"]);
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);

  const root = await realpath(sb.projectRoot);
  const sib = wtPath(root, "feature-a");
  await writeFile(path.join(sib, "scratch.txt"), "dirty\n");

  const r = await sb.worm(["destroy", "--force"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /project is no more/);

  await assert.rejects(stat(path.join(sb.projectRoot, ".worm")), /ENOENT/);
  await assert.rejects(stat(sib), /ENOENT/, "sibling worktree removed");
  await assert.rejects(stat(path.join(sb.wormHome, "projects", "demo")), /ENOENT/);

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
  assert.match(r.stderr, /not a worm-bound project/);
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

test("worm sync --global links HOME-scope shared paths (existing + sprouted) and is idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]); // provisions ~/.worm

  // Two global tails: one with an existing source, one to be sprouted.
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ shared_paths: [".claude/commands", ".claude/skills"] })
  );
  await mkdir(path.join(sb.wormHome, "shared", ".claude", "commands"), { recursive: true });
  await writeFile(path.join(sb.wormHome, "shared", ".claude", "commands", "x.md"), "hi\n");

  const r = await sb.worm(["sync", "--global"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // ~/.claude/commands → ~/.worm/shared/.claude/commands (absolute symlink).
  const cmdsLink = path.join(sb.wormHome, ".claude", "commands");
  assert.ok(path.isAbsolute(await readlink(cmdsLink)), "global links are absolute");
  assert.equal(
    await realpath(cmdsLink),
    await realpath(path.join(sb.wormHome, "shared", ".claude", "commands"))
  );

  // The missing source was sprouted as an empty dir, then linked.
  assert.equal(
    (await stat(path.join(sb.wormHome, "shared", ".claude", "skills"))).isDirectory(),
    true,
    "missing global source is sprouted"
  );
  assert.equal(
    await realpath(path.join(sb.wormHome, ".claude", "skills")),
    await realpath(path.join(sb.wormHome, "shared", ".claude", "skills"))
  );

  // Manifest records both tails and is gitignored out of the personal repo.
  const manifest = JSON.parse(await readFile(path.join(sb.wormHome, ".managed-links.json"), "utf8"));
  assert.deepEqual(Object.values(manifest)[0], [".claude/commands", ".claude/skills"]);
  assert.match(await readFile(path.join(sb.wormHome, ".gitignore"), "utf8"), /\.managed-links\.json/);

  // Idempotent.
  const r2 = await sb.worm(["sync", "--global"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
});

test("worm sync --global prunes a tail removed from the global config", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ shared_paths: [".claude/commands", ".claude/skills"] })
  );
  await sb.worm(["sync", "--global"]);
  await readlink(path.join(sb.wormHome, ".claude", "skills")); // exists before

  // Drop skills, re-sync.
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ shared_paths: [".claude/commands"] })
  );
  await sb.worm(["sync", "--global"]);

  await assert.rejects(readlink(path.join(sb.wormHome, ".claude", "skills")), /ENOENT/, "pruned");
  await readlink(path.join(sb.wormHome, ".claude", "commands")); // still linked
  const manifest = JSON.parse(await readFile(path.join(sb.wormHome, ".managed-links.json"), "utf8"));
  assert.deepEqual(Object.values(manifest)[0], [".claude/commands"]);
});

test("worm sync --global refuses to clobber a real path (warns, leaves it)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  // A REAL ~/.claude/commands dir already exists (not a worm-managed symlink).
  await mkdir(path.join(sb.wormHome, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(sb.wormHome, ".claude", "commands", "mine.md"), "keep\n");
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ shared_paths: [".claude/commands"] })
  );

  const r = await sb.worm(["sync", "--global"]);
  assert.equal(r.exitCode, 0, "a real path is a warning, not fatal");
  assert.match(r.stdout + r.stderr, /real path/);
  // Still a real dir (not a symlink), and its contents survive.
  await assert.rejects(readlink(path.join(sb.wormHome, ".claude", "commands")), "left as a real dir");
  await stat(path.join(sb.wormHome, ".claude", "commands", "mine.md"));
});

test("worm sync --global is a no-op with a hint when nothing is configured", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  const r = await sb.worm(["sync", "--global"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /Nothing global configured/i);
  await assert.rejects(stat(path.join(sb.wormHome, ".managed-links.json")), /ENOENT/, "no manifest fabricated");
});

test("init produces the consolidated layout (recipes/logs symlinks into the profile)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  const profile = path.join(sb.wormHome, "projects", path.basename(sb.projectRoot));
  // .worm/recipes and .worm/logs are absolute symlinks into the profile.
  assert.ok(path.isAbsolute(await readlink(path.join(sb.projectRoot, ".worm", "recipes"))));
  assert.equal(
    await realpath(path.join(sb.projectRoot, ".worm", "recipes")),
    await realpath(path.join(profile, "recipes"))
  );
  assert.equal(
    await realpath(path.join(sb.projectRoot, ".worm", "logs")),
    await realpath(path.join(profile, "logs"))
  );
  // Generated logs in the profile are gitignored out of the personal ~/.worm repo.
  assert.match(await readFile(path.join(profile, "logs", ".gitignore"), "utf8"), /^\*$/m);
});

test("shared_paths can pull a tail from a named external store; edits land in that repo", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const teamRepo = await mkdtemp(path.join(tmpdir(), "worm-team-"));
  t.after(() => rm(teamRepo, { recursive: true, force: true }));
  await mkdir(path.join(teamRepo, ".claude", "docs"), { recursive: true });
  await writeFile(path.join(teamRepo, ".claude", "docs", "guide.md"), "TEAM\n");

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      shared_paths: [".env", { path: ".claude/docs", store: "team" }],
      stores: { team: { root: teamRepo } },
      hooks: {},
    })
  );
  await sb.worm(["init", "--template", templateDir]);

  // .claude/docs links into the EXTERNAL store; .env still comes from the profile.
  const docsLink = path.join(sb.projectRoot, ".claude", "docs");
  assert.equal(await realpath(docsLink), await realpath(path.join(teamRepo, ".claude", "docs")));
  assert.equal(await readFile(path.join(docsLink, "guide.md"), "utf8"), "TEAM\n");
  assert.match(await readlink(path.join(sb.projectRoot, ".env")), /projects\/.+\/\.env$/);

  // Editing through the slot lands in the team repo (intended — two repos wired).
  await writeFile(path.join(docsLink, "new.md"), "added\n");
  assert.equal(await readFile(path.join(teamRepo, ".claude", "docs", "new.md"), "utf8"), "added\n");
});

test("a store with a url is cloned on demand when its root is missing", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  // A source git repo to serve as the store's url.
  const src = await mkdtemp(path.join(tmpdir(), "worm-store-src-"));
  t.after(() => rm(src, { recursive: true, force: true }));
  await execa("git", ["init", "-q", "-b", "main"], { cwd: src });
  await execa("git", ["config", "user.email", "t@e.com"], { cwd: src });
  await execa("git", ["config", "user.name", "T"], { cwd: src });
  await mkdir(path.join(src, "docs"), { recursive: true });
  await writeFile(path.join(src, "docs", "team.md"), "CLONED\n");
  await execa("git", ["add", "."], { cwd: src });
  await execa("git", ["commit", "-q", "-m", "init"], { cwd: src });

  const dstParent = await mkdtemp(path.join(tmpdir(), "worm-store-dst-"));
  t.after(() => rm(dstParent, { recursive: true, force: true }));
  const root = path.join(dstParent, "team"); // does not exist yet

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [{ path: "docs", store: "team" }], stores: { team: { url: src, root } }, hooks: {} })
  );
  const r = await sb.worm(["init", "--template", templateDir]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /cloning/i);

  await stat(path.join(root, ".git")); // store was cloned to its root
  assert.equal(await readFile(path.join(sb.projectRoot, "docs", "team.md"), "utf8"), "CLONED\n");
});

test("a store whose root is missing and has no url errors cleanly", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [{ path: "docs", store: "team" }], stores: { team: { root: "/no/such/worm/store/root" } }, hooks: {} })
  );
  const r = await sb.worm(["init", "--template", templateDir]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /root not found/i);
  assert.match(r.stderr, /add a "url"/);
});

test("referencing an undeclared store errors cleanly", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [{ path: "docs", store: "ghost" }], hooks: {} })
  );
  const r = await sb.worm(["init", "--template", templateDir]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Unknown store "ghost"/);
});

test("a project can reference a store declared in the global config", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const ext = await mkdtemp(path.join(tmpdir(), "worm-gstore-"));
  t.after(() => rm(ext, { recursive: true, force: true }));
  await mkdir(path.join(ext, "shared"), { recursive: true });
  await writeFile(path.join(ext, "shared", "f.md"), "G\n");

  await sb.worm(["init"]); // provisions ~/.worm
  // Global config declares the store; the project references it.
  await writeFile(path.join(sb.wormHome, "config.json"), JSON.stringify({ stores: { org: { root: ext } } }));
  const profileCfg = path.join(sb.wormHome, "projects", path.basename(sb.projectRoot), "config.json");
  await writeFile(profileCfg, JSON.stringify({ shared_paths: [{ path: "shared", store: "org" }], hooks: {} }));

  const r = await sb.worm(["sync"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(
    await realpath(path.join(sb.projectRoot, "shared")),
    await realpath(path.join(ext, "shared")),
    "linked from the GLOBAL store"
  );
});

test("worm template render substitutes {{vars}} and leaves shell ${VAR} untouched", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const tmpl = path.join(sb.projectRoot, "x.tmpl");
  await writeFile(tmpl, "name: {{project}}-sandbox\nmount: ${SANDBOX_DIR}\nport: {{ port }}\n");

  const r = await sb.worm(["template", "render", tmpl, "project=app", "port=3000"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /name: app-sandbox/);
  assert.match(r.stdout, /mount: \$\{SANDBOX_DIR\}/, "shell ${VAR} is left untouched");
  assert.match(r.stdout, /port: 3000/);
});

test("worm template render errors on an unknown {{var}} (strict)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const tmpl = path.join(sb.projectRoot, "x.tmpl");
  await writeFile(tmpl, "hello {{name}} {{ghost}}\n");

  const r = await sb.worm(["template", "render", tmpl, "name=world"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /unknown variable \{\{ghost\}\}/);
});

test("worm template render rejects a bad KEY=VALUE arg", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const tmpl = path.join(sb.projectRoot, "x.tmpl");
  await writeFile(tmpl, "{{a}}\n");

  const r = await sb.worm(["template", "render", tmpl, "noequals"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /expected KEY=VALUE/);
});

// --- per-worktree env files (the `env` config block) -------------------------

function parseDotenv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq !== -1) out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

// A project bound from a template config; returns { sb, root, profile }.
async function boundProject(t, config) {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(path.join(templateDir, "config.json"), JSON.stringify({ shared_paths: [], hooks: {}, ...config }));
  const init = await sb.worm(["init", "--template", templateDir]);
  assert.equal(init.exitCode, 0, init.stderr);
  const root = await realpath(sb.projectRoot);
  const profile = path.join(sb.wormHome, "projects", path.basename(sb.projectRoot));
  return { sb, root, profile };
}

const SLOT_ENV = {
  file: ".env.slot",
  vars: {
    PORT: "{{ 3000 + index * 100 }}",
    NAME: "{{ name }}",
    BRANCH: "{{ branch }}",
    PREFIX: "{{ index == 0 ? 'app' : 'app-slot' + index }}",
    NGROK: "{{ profile + (index == 0 ? '/.ngrok' : '/.ngrok.feat' + index) }}",
  },
};

test("env: no file until a slot is assigned; assign renders it, release removes it", async (t) => {
  const { sb, root, profile } = await boundProject(t, { env: SLOT_ENV });
  await createBranch(sb.projectRoot, "feature-a");
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const wt = wtPath(root, "feature-a");
  await assert.rejects(stat(path.join(root, ".env.slot")), /ENOENT/, "main has no slot → no file");
  await assert.rejects(stat(path.join(wt, ".env.slot")), /ENOENT/, "new worktree has no slot → no file");

  // Lowest free slot first: the worktree gets 0, main then gets 1.
  const a = await sb.worm(["slot", "assign"], { cwd: wt });
  assert.equal(a.exitCode, 0, a.stderr);
  assert.match(a.stdout, /feature-a → slot 0/);
  const env0 = parseDotenv(await readFile(path.join(wt, ".env.slot"), "utf8"));
  assert.deepEqual(env0, {
    PORT: "3000",
    NAME: "feature-a",
    BRANCH: "feature-a",
    PREFIX: "app",
    NGROK: `${profile}/.ngrok`,
  });

  await sb.worm(["slot", "assign", "main"]);
  const env1 = parseDotenv(await readFile(path.join(root, ".env.slot"), "utf8"));
  assert.equal(env1.PORT, "3100");
  assert.equal(env1.NAME, "main");
  assert.equal(env1.PREFIX, "app-slot1");
  assert.equal(env1.NGROK, `${profile}/.ngrok.feat1`);

  // Git never sees the generated file.
  const st = await execa("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: wt });
  assert.doesNotMatch(st.stdout, /\.env\.slot/);

  // Sync re-renders deterministically (no churn) and keeps the slot.
  const before = await readFile(path.join(wt, ".env.slot"), "utf8");
  await sb.worm(["sync"]);
  assert.equal(await readFile(path.join(wt, ".env.slot"), "utf8"), before);

  const rel = await sb.worm(["slot", "release"], { cwd: wt });
  assert.equal(rel.exitCode, 0, rel.stderr);
  assert.match(rel.stdout, /released slot 0/);
  await assert.rejects(stat(path.join(wt, ".env.slot")), /ENOENT/);
});

test("env: expression errors fail cleanly at render time", async (t) => {
  const { sb } = await boundProject(t, { env: { vars: { X: "{{ bogus }}" } } });
  const r = await sb.worm(["slot", "assign", "main"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /unknown variable "bogus"/);

  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "projects", name, "config.json");
  for (const [expr, err] of [
    ["{{ name * 2 }}", /needs numbers/],
    ["{{ index == 0 ? 'a' }}", /expected ':'/],
    ["{{ 'open }}", /Unterminated string/],
  ]) {
    await writeFile(cfgPath, JSON.stringify({ shared_paths: [], hooks: {}, env: { vars: { X: expr } } }));
    const bad = await sb.worm(["slot", "assign", "main"]);
    assert.notEqual(bad.exitCode, 0, expr);
    assert.match(bad.stderr, err, expr);
  }
});

test("slots: lowest free by default, explicit numbers, conflicts and range", async (t) => {
  const { sb, root } = await boundProject(t, { slots: { step: 100, max: 2 } });
  for (const b of ["a", "b", "c"]) {
    await createBranch(sb.projectRoot, b);
    await sb.worm(["worktree", "add", b, "--no-setup"]);
  }
  assert.match((await sb.worm(["slot", "assign", "b", "2"])).stdout, /b → slot 2/);
  assert.match((await sb.worm(["slot", "assign", "a"])).stdout, /a → slot 0/);
  assert.match((await sb.worm(["slot", "assign", "a"])).stdout, /already holds slot 0/, "idempotent");

  const taken = await sb.worm(["slot", "assign", "c", "2"]);
  assert.notEqual(taken.exitCode, 0);
  assert.match(taken.stderr, /Slot 2 is held by/);
  const range = await sb.worm(["slot", "assign", "c", "7"]);
  assert.notEqual(range.exitCode, 0);
  assert.match(range.stderr, /out of range \(0–2\)/);
  const move = await sb.worm(["slot", "assign", "a", "1"]);
  assert.notEqual(move.exitCode, 0);
  assert.match(move.stderr, /already holds slot 0/);

  assert.match((await sb.worm(["slot", "assign", "c"])).stdout, /c → slot 1/);
  const full = await sb.worm(["slot", "assign", "main"]);
  assert.notEqual(full.exitCode, 0);
  assert.match(full.stderr, /All 3 slots are taken/);

  const ls = JSON.parse((await sb.worm(["slot", "ls", "--json"])).stdout);
  assert.equal(ls.step, 100);
  assert.deepEqual(ls.slots.map((r) => r.name), ["a", "c", "b"]);
  assert.deepEqual(ls.free, []);

  // `slot current` follows the cwd; exit 1 when the worktree holds none.
  const cur = await sb.worm(["slot", "current"], { cwd: wtPath(root, "b") });
  assert.equal(cur.stdout.trim(), "2");
  const none = await sb.worm(["slot", "current"]);
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /holds no slot/);

  // Release by slot number.
  assert.match((await sb.worm(["slot", "release", "2"])).stdout, /b released slot 2/);
  assert.deepEqual(JSON.parse((await sb.worm(["slot", "ls", "--json"])).stdout).free, [2]);
});

test("slots: a worktree deleted behind worm's back frees its slot", async (t) => {
  const { sb, root } = await boundProject(t, {});
  await createBranch(sb.projectRoot, "a");
  await sb.worm(["worktree", "add", "a", "--no-setup"]);
  await sb.worm(["slot", "assign", "a"]);
  await execa("git", ["worktree", "remove", "--force", wtPath(root, "a")], { cwd: root });
  const ls = JSON.parse((await sb.worm(["slot", "ls", "--json"])).stdout);
  assert.equal(ls.slots[0].worktree, null);
  assert.match((await sb.worm(["slot", "assign", "main"])).stdout, /main → slot 0/);
});

test("on_assign / on_release run with the slot in WORM_SLOT", async (t) => {
  const { sb, root, profile } = await boundProject(t, {
    hooks: {
      on_assign: 'echo "ASSIGN slot=$WORM_SLOT name=$WORM_WORKTREE_NAME" >> "$WORM_PROFILE/hooks.log"',
      on_release: 'echo "RELEASE slot=$WORM_SLOT env=$(cat .env.slot 2>/dev/null | wc -l | tr -d " ")" >> "$WORM_PROFILE/hooks.log"',
    },
    env: { vars: { PORT: "{{ 3000 + index * 100 }}" } },
  });
  await sb.worm(["slot", "assign", "main", "4"]);
  await sb.worm(["slot", "assign", "main", "4"]); // idempotent: no second on_assign
  await sb.worm(["slot", "release", "main"]);
  const log = (await readFile(path.join(profile, "hooks.log"), "utf8")).trim().split("\n");
  assert.deepEqual(log, ["ASSIGN slot=4 name=main", "RELEASE slot=4 env=2"], "on_release sees the env file");
  await assert.rejects(stat(path.join(root, ".env.slot")), /ENOENT/);
});

// --- worm wire / worm detach -------------------------------------------------

test("worm wire applies the cognitive layer to an externally-created worktree", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      shared_paths: [".env"],
      env: { vars: { PORT: "{{ 3000 + index * 100 }}", BR: "{{ branch }}" } },
      hooks: {},
    })
  );
  await sb.worm(["init", "--template", templateDir]);

  // A worktree worm did NOT create, at a non-sibling path (à la Conductor).
  const extParent = await mkdtemp(path.join(tmpdir(), "worm-ext-"));
  t.after(() => rm(extParent, { recursive: true, force: true }));
  const extPath = path.join(extParent, "conductor-wt");
  await execa("git", ["worktree", "add", extPath, "feature-a"], { cwd: sb.projectRoot });

  // Before wiring: no tunnel, no env file.
  await assert.rejects(readlink(path.join(extPath, ".env")), "no tunnel before wire");

  const r = await sb.worm(["wire", extPath]);
  assert.equal(r.exitCode, 0, r.stderr);

  const extReal = await realpath(extPath);
  const link = await readlink(path.join(extReal, ".env"));
  assert.match(link, /projects\/.+\/\.env$/, "shared_path tunnel linked into the profile");
  await assert.rejects(stat(path.join(extReal, ".env.slot")), /ENOENT/, "no slot → no env file");
  const slugLink = path.join(sb.wormHome, ".claude", "projects", claudeSlug(extReal));
  assert.ok((await lstat(slugLink)).isSymbolicLink(), "its Claude dir is linked to main's");

  // Once it holds a slot, wire (re)renders the env file for it.
  await sb.worm(["slot", "assign", extReal, "2"]);
  await rm(path.join(extReal, ".env.slot"));
  const r2 = await sb.worm(["wire", extPath]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  const env = parseDotenv(await readFile(path.join(extReal, ".env.slot"), "utf8"));
  assert.deepEqual(env, { PORT: "3200", BR: "feature-a" });
});

test("worm detach localises a tunnel in one slot and survives sync", async (t) => {
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

  // Give the shared source some content, and add a sibling that shares it.
  const name = path.basename(sb.projectRoot);
  await writeFile(path.join(sb.wormHome, "projects", name, ".env"), "SHARED=1\n");
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const root = await realpath(sb.projectRoot);

  // Detach .env in Slot 0 (cwd defaults to projectRoot).
  const r = await sb.worm(["detach", ".env"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // Slot 0: now a real file with the copied content; the sibling keeps the link.
  await assert.rejects(readlink(path.join(root, ".env")), "Slot 0 .env is no longer a symlink");
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "SHARED=1\n");
  await readlink(path.join(wtPath(root, "feature-a"), ".env")); // resolves → still a tunnel

  // Local edits survive a sync (deref-guard: a real file is never relinked).
  await writeFile(path.join(root, ".env"), "LOCAL=1\n");
  const r2 = await sb.worm(["sync"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  await assert.rejects(readlink(path.join(root, ".env")), "still a real file after sync");
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "LOCAL=1\n", "local edit preserved");
});

test("worm detach refuses a file that isn't a managed tunnel", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]); // default config: no shared_paths

  const r = await sb.worm(["detach", ".env"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /isn't a worm-managed link/);
});

// --- autosync recipe ---------------------------------------------------------

// Turn the sandbox's WORM_HOME into a committed git repo with a bare remote.
async function initHomeGitRemote(t, sb) {
  const home = sb.wormHome;
  await execa("git", ["-C", home, "config", "user.email", "home@e.com"]);
  await execa("git", ["-C", home, "config", "user.name", "Home"]);
  await execa("git", ["-C", home, "add", "-A"]);
  await execa("git", ["-C", home, "commit", "-q", "-m", "initial"]);
  const bare = await mkdtemp(path.join(tmpdir(), "worm-remote-"));
  t.after(() => rm(bare, { recursive: true, force: true }));
  await execa("git", ["init", "--bare", "-q", bare]);
  await execa("git", ["-C", home, "remote", "add", "origin", bare]);
  const branch = (await execa("git", ["-C", home, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  return { home, bare, branch };
}

// Declare autosync in the GLOBAL config (~/.worm/config.json).
async function setGlobalAutosync(sb, opts = {}) {
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { autosync: { debounceMinutes: 0, notify: false, ...opts } } })
  );
}

test("worm sync --global wires autosync into ~/.claude/settings.json (and strips on removal)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await setGlobalAutosync(sb);

  const r = await sb.worm(["sync", "--global"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // HOME=wormHome in the sandbox, so ~/.claude/settings.json lives there.
  const settingsPath = path.join(sb.wormHome, ".claude", "settings.json");
  const s = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /hook trigger --global session-start/);
  assert.match(s.hooks.Stop[0].hooks[0].command, /hook trigger --global stop/);
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /hook trigger --global session-end/);
  // Claude's worktree hooks live here too, in the user tier (Desktop auto-trusts those).
  assert.match(s.hooks.WorktreeCreate[0].hooks[0].command, /^worm hook worktree-create$/);
  assert.equal(s.hooks.WorktreeCreate[0].hooks[0].timeout, 600);
  assert.match(s.hooks.WorktreeRemove[0].hooks[0].command, /^worm hook worktree-remove$/);
  // GLOBAL scope only — never wired into a project worktree.
  await assert.rejects(stat(path.join(sb.projectRoot, ".claude", "settings.local.json")), /ENOENT/);

  // Removing it from the global config + re-syncing strips the hooks.
  await writeFile(path.join(sb.wormHome, "config.json"), JSON.stringify({}));
  await sb.worm(["sync", "--global"]);
  const s2 = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.ok(!s2.hooks?.Stop, "autosync hooks stripped after removal");
  assert.ok(s2.hooks.WorktreeCreate, "the worktree hooks stay (they don't depend on recipes)");
});

test("global autosync push commits and pushes ~/.worm to its remote", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await setGlobalAutosync(sb);
  const { home, bare } = await initHomeGitRemote(t, sb);

  // A new change in ~/.worm, then fire the global Stop dispatch.
  await writeFile(path.join(home, "shared", "newfile.md"), "hello\n");
  const r = await sb.worm(["hook", "trigger", "--global", "stop"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // The remote received it; machine-local state stayed out of the push.
  const checkout = await mkdtemp(path.join(tmpdir(), "worm-check-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await execa("git", ["clone", "-q", bare, checkout]);
  await stat(path.join(checkout, "shared", "newfile.md"));
  await assert.rejects(stat(path.join(checkout, ".managed-links.json")), /ENOENT/);
});

test("global autosync never auto-resolves: conflict → clean repo + marker + status surfaces it", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await setGlobalAutosync(sb);
  const { home, bare, branch } = await initHomeGitRemote(t, sb);
  await execa("git", ["-C", home, "push", "-q", "origin", branch]);

  // Another clone pushes a conflicting change to the same file.
  const other = await mkdtemp(path.join(tmpdir(), "worm-other-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await execa("git", ["clone", "-q", bare, other]);
  await execa("git", ["-C", other, "config", "user.email", "o@e.com"]);
  await execa("git", ["-C", other, "config", "user.name", "Other"]);
  await writeFile(path.join(other, "shared", "global-rules.md"), "REMOTE\n");
  await execa("git", ["-C", other, "commit", "-aqm", "remote change"]);
  await execa("git", ["-C", other, "push", "-q", "origin", branch]);

  // A conflicting local commit in ~/.worm, then the global pull (session-start).
  await writeFile(path.join(home, "shared", "global-rules.md"), "LOCAL\n");
  await execa("git", ["-C", home, "commit", "-aqm", "local change"]);
  const r = await sb.worm(["hook", "trigger", "--global", "session-start"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // Marker written; repo left clean (rebase aborted); local change intact.
  await stat(path.join(home, ".autosync-conflict.json"));
  const st = await execa("git", ["-C", home, "status", "--porcelain"]);
  assert.equal(st.stdout.trim(), "", "rebase aborted → clean working tree");
  assert.equal(await readFile(path.join(home, "shared", "global-rules.md"), "utf8"), "LOCAL\n");

  // `worm status` surfaces it (the durable, UI-less channel).
  const status = await sb.worm(["status"]);
  assert.match(status.stdout, /autosync: ~\/\.worm has an unresolved conflict/);

  // A clean push afterwards clears the marker (force local to win, then push).
  await execa("git", ["-C", home, "push", "-qf", "origin", branch]);
  const r2 = await sb.worm(["hook", "trigger", "--global", "stop"]);
  assert.equal(r2.exitCode, 0, r2.stderr);
  await assert.rejects(stat(path.join(home, ".autosync-conflict.json")), /ENOENT/, "marker cleared");
});

test("global autosync never strands UNCOMMITTED local work on a conflicting push", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await setGlobalAutosync(sb);
  const { home, bare, branch } = await initHomeGitRemote(t, sb);
  await execa("git", ["-C", home, "push", "-q", "origin", branch]);

  // Another clone pushes a conflicting change to the same file.
  const other = await mkdtemp(path.join(tmpdir(), "worm-other-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await execa("git", ["clone", "-q", bare, other]);
  await execa("git", ["-C", other, "config", "user.email", "o@e.com"]);
  await execa("git", ["-C", other, "config", "user.name", "Other"]);
  await writeFile(path.join(other, "shared", "global-rules.md"), "REMOTE\n");
  await execa("git", ["-C", other, "commit", "-aqm", "remote change"]);
  await execa("git", ["-C", other, "push", "-q", "origin", branch]);

  // Local work is UNCOMMITTED (the case the old `rebase --autostash` mishandled:
  // a pop-conflict stranded it in refs/stash with no marker). Fire the push.
  await writeFile(path.join(home, "shared", "global-rules.md"), "LOCAL\n");
  const r = await sb.worm(["hook", "trigger", "--global", "stop"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // Conflict marker written, working tree clean (rebase aborted)…
  await stat(path.join(home, ".autosync-conflict.json"));
  const st = await execa("git", ["-C", home, "status", "--porcelain"]);
  assert.equal(st.stdout.trim(), "", "rebase aborted → clean working tree");
  // …and the local work is SAFE on HEAD (committed before integrating), not lost
  // to a dangling stash.
  const head = await execa("git", ["-C", home, "show", "HEAD:shared/global-rules.md"]);
  assert.equal(head.stdout, "LOCAL", "uncommitted work was committed, not stranded");
  const stash = await execa("git", ["-C", home, "stash", "list"]);
  assert.equal(stash.stdout.trim(), "", "nothing stranded in refs/stash");
});

test("global autosync retries (no conflict marker) when a racing writer dirties the tree mid-rebase", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await setGlobalAutosync(sb);
  const { home, bare, branch } = await initHomeGitRemote(t, sb);
  await execa("git", ["-C", home, "push", "-q", "origin", branch]);

  // A non-conflicting remote commit (different file), so the local rebase has real
  // work to do and actually invokes the pre-rebase hook below (git short-circuits
  // "up to date" without running hooks when HEAD is merely ahead).
  const other = await mkdtemp(path.join(tmpdir(), "worm-other-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await execa("git", ["clone", "-q", bare, other]);
  await execa("git", ["-C", other, "config", "user.email", "o@e.com"]);
  await execa("git", ["-C", other, "config", "user.name", "Other"]);
  await writeFile(path.join(other, "shared", "remote-only.md"), "REMOTE\n");
  await execa("git", ["-C", other, "add", "-A"]);
  await execa("git", ["-C", other, "commit", "-qm", "remote change"]);
  await execa("git", ["-C", other, "push", "-q", "origin", branch]);

  // Simulate a concurrent writer (syncGlobalPermissions / a permission-dialog write
  // through a tunnel) landing in the commit→rebase window: a ONE-SHOT pre-rebase
  // hook dirties a tracked file and refuses the FIRST rebase, then steps aside. The
  // sync must absorb the racing write (re-commit) and retry — NOT cry conflict.
  const hookPath = path.join(home, ".git", "hooks", "pre-rebase");
  const sentinel = path.join(home, ".git", ".inject-dirty"); // absolute; lives in .git so `git add -A` never sees it
  await writeFile(
    hookPath,
    `#!/bin/sh
if [ -f "${sentinel}" ]; then
  rm -f "${sentinel}"
  printf 'racing write\\n' > shared/global-rules.md
  exit 1
fi
exit 0
`
  );
  await chmod(hookPath, 0o755);
  await writeFile(sentinel, "");

  // A normal local change, then fire the push (Stop).
  await writeFile(path.join(home, "shared", "newfile.md"), "hello\n");
  const r = await sb.worm(["hook", "trigger", "--global", "stop"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // No conflict marker — the dirty-tree failure was transient and got retried.
  await assert.rejects(stat(path.join(home, ".autosync-conflict.json")), /ENOENT/, "no false conflict");
  // The injection fired exactly once (sentinel consumed) and the tree is clean.
  await assert.rejects(stat(sentinel), /ENOENT/, "injection consumed");
  const st = await execa("git", ["-C", home, "status", "--porcelain"]);
  assert.equal(st.stdout.trim(), "", "clean working tree after retry");

  // Both the real change AND the absorbed racing write reached the remote.
  const checkout = await mkdtemp(path.join(tmpdir(), "worm-check-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await execa("git", ["clone", "-q", bare, checkout]);
  await stat(path.join(checkout, "shared", "newfile.md"));
  assert.equal(
    await readFile(path.join(checkout, "shared", "global-rules.md"), "utf8"),
    "racing write\n",
    "racing write was committed + pushed, not lost"
  );
});

test("global autosync no-ops cleanly when ~/.worm has no remote", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await setGlobalAutosync(sb);
  // No remote configured on WORM_HOME — the hook must exit 0 and do nothing.
  const r = await sb.worm(["hook", "trigger", "--global", "stop"]);
  assert.equal(r.exitCode, 0, r.stderr);
});

test("global autosync serializes: a held lock makes a concurrent run skip", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await setGlobalAutosync(sb);
  const { home, bare } = await initHomeGitRemote(t, sb);

  // Pre-hold the lock as if another session were mid-sync (mirrors the script's
  // LOCK_DIR naming: OS temp dir, keyed by the sanitized worm home).
  const lockDir = path.join(tmpdir(), `worm-autosync-${sb.wormHome.replace(/[^a-zA-Z0-9]/g, "_")}.lock`);
  await mkdir(lockDir, { recursive: true });
  t.after(() => rm(lockDir, { recursive: true, force: true }));

  await writeFile(path.join(home, "shared", "locked.md"), "x\n");
  const r = await sb.worm(["hook", "trigger", "--global", "stop"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // Lock held → the run skipped → nothing pushed to the remote.
  const c1 = await mkdtemp(path.join(tmpdir(), "worm-check-"));
  t.after(() => rm(c1, { recursive: true, force: true }));
  await execa("git", ["clone", "-q", bare, c1]);
  await assert.rejects(stat(path.join(c1, "shared", "locked.md")), /ENOENT/, "skipped while locked");

  // Release the lock → the next run pushes normally.
  await rm(lockDir, { recursive: true, force: true });
  await sb.worm(["hook", "trigger", "--global", "stop"]);
  const c2 = await mkdtemp(path.join(tmpdir(), "worm-check2-"));
  t.after(() => rm(c2, { recursive: true, force: true }));
  await execa("git", ["clone", "-q", bare, c2]);
  await stat(path.join(c2, "shared", "locked.md"));
});

test("worm sync --global wires the notifyPendingInput + syncGlobalPermissions global recipes", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { notifyPendingInput: {}, syncGlobalPermissions: {} } })
  );

  const r = await sb.worm(["sync", "--global"]);
  assert.equal(r.exitCode, 0, r.stderr);

  const s = JSON.parse(await readFile(path.join(sb.wormHome, ".claude", "settings.json"), "utf8"));
  // syncGlobalPermissions → start/end/stop ; notifyPendingInput → stop/permission-request.
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /hook trigger --global session-start/);
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /hook trigger --global session-end/);
  assert.match(s.hooks.Stop[0].hooks[0].command, /hook trigger --global stop/);
  assert.match(s.hooks.PermissionRequest[0].hooks[0].command, /hook trigger --global permission-request/);
  // ONE dispatcher entry per event, even though two recipes both contribute `stop`.
  assert.equal(s.hooks.Stop.length, 1);
});

test("syncGlobalPermissions merges the global permissions block bidirectionally (no base → union)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: {} } })
  );

  // Live global settings: a permission + a non-permission key that must survive.
  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await writeFile(liveFile, JSON.stringify({ permissions: { allow: ["Bash(live)"] }, trustedDirectories: ["/x"] }));
  // Canonical git-tracked copy holds a different rule.
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(canonFile), { recursive: true });
  await writeFile(canonFile, JSON.stringify({ permissions: { allow: ["Bash(canon)"] } }));

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.deepEqual(new Set(live.permissions.allow), new Set(["Bash(live)", "Bash(canon)"]), "live ∪ canon");
  assert.deepEqual(live.trustedDirectories, ["/x"], "non-permission keys preserved in the live file");
  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.deepEqual(new Set(canon.permissions.allow), new Set(["Bash(live)", "Bash(canon)"]));
  assert.ok(!canon.trustedDirectories, "canonical holds permissions only");
  // The 3-way base snapshot is written for next time — and gitignored.
  const base = JSON.parse(await readFile(path.join(sb.wormHome, ".sync-global-settings.base.json"), "utf8"));
  assert.deepEqual(new Set(base.permissions.allow), new Set(["Bash(live)", "Bash(canon)"]));
  const gitignore = await readFile(path.join(sb.wormHome, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.sync-global-settings\.base\.json$/m, "base snapshot is gitignored");
});

test("syncGlobalPermissions propagates a removal from the live file (3-way merge)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: {} } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await mkdir(path.dirname(canonFile), { recursive: true });

  // Round 1: both hold [A, B] → establishes the base snapshot.
  await writeFile(liveFile, JSON.stringify({ permissions: { allow: ["Bash(A)", "Bash(B)"] } }));
  await writeFile(canonFile, JSON.stringify({ permissions: { allow: ["Bash(A)", "Bash(B)"] } }));
  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  // The user removes B from the LIVE file (e.g. an agent tightened permissions).
  await writeFile(liveFile, JSON.stringify({ permissions: { allow: ["Bash(A)"] } }));
  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  // Under the OLD grow-only union B would come back; the 3-way merge drops it.
  const live = JSON.parse(await readFile(liveFile, "utf8"));
  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.deepEqual(live.permissions.allow, ["Bash(A)"], "removal survives on the live file");
  assert.deepEqual(canon.permissions.allow, ["Bash(A)"], "removal propagated to the canonical file");
});

test("syncGlobalPermissions: an addition on one side still flows while a removal on the other propagates", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: {} } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await mkdir(path.dirname(canonFile), { recursive: true });

  // Base = [A, B].
  await writeFile(liveFile, JSON.stringify({ permissions: { allow: ["Bash(A)", "Bash(B)"] } }));
  await writeFile(canonFile, JSON.stringify({ permissions: { allow: ["Bash(A)", "Bash(B)"] } }));
  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  // Live removes B; canon (e.g. pulled from another machine) adds C.
  await writeFile(liveFile, JSON.stringify({ permissions: { allow: ["Bash(A)"] } }));
  await writeFile(canonFile, JSON.stringify({ permissions: { allow: ["Bash(A)", "Bash(B)", "Bash(C)"] } }));
  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.deepEqual(new Set(live.permissions.allow), new Set(["Bash(A)", "Bash(C)"]), "B removed, C added");
});

test("syncGlobalPermissions: sandbox is now bidirectional (last-edited-wins, not one-way)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: {} } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await mkdir(path.dirname(canonFile), { recursive: true });

  // Base: both agree sandbox is enabled.
  await writeFile(liveFile, JSON.stringify({ permissions: {}, sandbox: { enabled: true } }));
  await writeFile(canonFile, JSON.stringify({ permissions: {}, sandbox: { enabled: true } }));
  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  // The user edits sandbox in the LIVE file only. The old recipe forced canonical
  // onto live one-way and reverted this; the 3-way merge keeps the live edit and
  // pushes it to canonical.
  await writeFile(liveFile, JSON.stringify({ permissions: {}, sandbox: { enabled: false } }));
  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const live = JSON.parse(await readFile(liveFile, "utf8"));
  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.deepEqual(live.sandbox, { enabled: false }, "live sandbox edit preserved");
  assert.deepEqual(canon.sandbox, { enabled: false }, "live sandbox edit propagated to canonical");
});

test("syncGlobalPermissions AUTO mode syncs primitive keys but leaves structural keys local", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: {} } }) // no `keys` → auto mode
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await writeFile(
    liveFile,
    JSON.stringify({
      permissions: { allow: ["Bash(x)"] },
      effortLevel: "high", // primitive → synced
      tui: "fullscreen", // primitive → synced
      env: { NODE_USE_ENV_PROXY: "1" }, // object → local
      trustedDirectories: ["/a"], // array → local
    })
  );

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.equal(canon.effortLevel, "high", "primitive effortLevel synced");
  assert.equal(canon.tui, "fullscreen", "primitive tui synced");
  assert.ok(!("env" in canon), "object key stays local");
  assert.ok(!("trustedDirectories" in canon), "array key stays local");
  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.deepEqual(live.env, { NODE_USE_ENV_PROXY: "1" }, "local object preserved in live file");
  assert.deepEqual(live.trustedDirectories, ["/a"], "local array preserved in live file");
});

test("syncGlobalPermissions syncs a configurable extra key (tui) and canonical holds only synced keys", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: { keys: ["permissions", "tui"] } } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  // A synced key (tui) + an unsynced key (effortLevel) that must stay local.
  await writeFile(liveFile, JSON.stringify({ permissions: {}, tui: "fullscreen", effortLevel: "high" }));

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.equal(canon.tui, "fullscreen", "tui flowed to canonical");
  assert.ok(!("effortLevel" in canon), "unsynced key stays out of canonical");
  assert.ok(!("sandbox" in canon), "sandbox not synced when not in the key set");
  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.equal(live.effortLevel, "high", "unsynced key preserved locally");
});

test("syncGlobalPermissions merges an object-valued key PER LEAF, not as an opaque value", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: { keys: ["permissions", "autoMode"] } } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await mkdir(path.dirname(canonFile), { recursive: true });

  // Base: both sides agree on one soft_deny rule.
  const agreed = { permissions: {}, autoMode: { soft_deny: ["rule-shared"] } };
  await writeFile(liveFile, JSON.stringify(agreed));
  await writeFile(canonFile, JSON.stringify(agreed));
  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  // Now BOTH diverge, in DIFFERENT sub-keys — the case an opaque last-edited-wins
  // resolved by discarding one side's whole autoMode block.
  await writeFile(
    liveFile,
    JSON.stringify({ permissions: {}, autoMode: { soft_deny: ["rule-shared"], environment: ["from-live"] } })
  );
  await writeFile(
    canonFile,
    JSON.stringify({ permissions: {}, autoMode: { soft_deny: ["rule-shared", "from-canon"] } })
  );
  // Make canonical unambiguously the more recently edited file, so a fallback to
  // last-edited-wins would drop the live side's addition.
  const past = new Date(Date.now() - 60_000);
  await utimes(liveFile, past, past);

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.deepEqual(
    new Set(live.autoMode.soft_deny),
    new Set(["rule-shared", "from-canon"]),
    "canonical's array addition merged in"
  );
  assert.deepEqual(live.autoMode.environment, ["from-live"], "live's sibling key survived the merge");
  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.deepEqual(canon.autoMode.environment, ["from-live"], "…and propagated to canonical");
});

test("syncGlobalPermissions syncs the user's own hooks but never worm's dispatcher entries", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: { keys: ["permissions", "hooks"] } } })
  );
  await sb.worm(["sync", "--global"]); // wires worm's own `hook trigger --global` entries

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.ok(
    live.hooks.SessionStart.some((e) => e.hooks[0].command.includes("hook trigger")),
    "worm wired its own entry"
  );
  // The user adds their own hook alongside worm's.
  live.hooks.SessionStart.push({ hooks: [{ type: "command", command: "bash ~/.worm/shared/scripts/mine.sh" }] });
  await writeFile(liveFile, JSON.stringify(live));

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  const canonCmds = canon.hooks.SessionStart.map((e) => e.hooks[0].command);
  assert.deepEqual(canonCmds, ["bash ~/.worm/shared/scripts/mine.sh"], "only the user's entry is tracked");
  assert.ok(
    !JSON.stringify(canon.hooks).includes("hook trigger"),
    "worm's dispatcher entries never reach the canonical copy"
  );

  // Re-wiring must not fight the sync: worm's entry stays, unduplicated, and the
  // user's entry survives both writers.
  await sb.worm(["sync", "--global"]);
  await sb.worm(["hook", "trigger", "--global", "session-start"]);
  const after = JSON.parse(await readFile(liveFile, "utf8"));
  const cmds = after.hooks.SessionStart.map((e) => e.hooks[0].command);
  assert.equal(cmds.filter((c) => c.includes("hook trigger")).length, 1, "no duplicate worm entry");
  assert.ok(cmds.includes("bash ~/.worm/shared/scripts/mine.sh"), "user's hook survives re-wiring");
});

test('syncGlobalPermissions keys:"*" syncs every key but the denylist', async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: { keys: "*" } } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await writeFile(
    liveFile,
    JSON.stringify({
      permissions: { allow: ["Bash(x)"] },
      autoMode: { soft_deny: ["a-rule"] }, // object → swept up by the wildcard
      extraKnownMarketplaces: { m: { source: "github" } },
      tui: "fullscreen",
      env: { ANTHROPIC_API_KEY: "sk-secret" }, // denylisted → must stay local
      trustedDirectories: ["/a"], // denylisted → must stay local
    })
  );

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.deepEqual(canon.autoMode, { soft_deny: ["a-rule"] }, "structured key synced");
  assert.deepEqual(canon.extraKnownMarketplaces, { m: { source: "github" } });
  assert.equal(canon.tui, "fullscreen");
  assert.ok(!("env" in canon), "env is denylisted — never reaches the git-tracked copy");
  assert.ok(!("trustedDirectories" in canon), "trustedDirectories is denylisted");
  assert.ok(!JSON.stringify(canon).includes("sk-secret"), "no credential leaked into the repo");
  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.deepEqual(live.env, { ANTHROPIC_API_KEY: "sk-secret" }, "denylisted keys survive locally");
  assert.deepEqual(live.trustedDirectories, ["/a"]);
});

test('syncGlobalPermissions keys:["*","env"] opts a denylisted key back in', async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: { keys: ["*", "env"] } } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await writeFile(
    liveFile,
    JSON.stringify({ permissions: {}, env: { NODE_USE_ENV_PROXY: "1" }, trustedDirectories: ["/a"] })
  );

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const canon = JSON.parse(await readFile(canonFile, "utf8"));
  assert.deepEqual(canon.env, { NODE_USE_ENV_PROXY: "1" }, "explicitly named key beats the denylist");
  assert.ok(!("trustedDirectories" in canon), "the rest of the denylist still applies");
});

test("syncGlobalPermissions pulls a hooks entry that only the canonical copy has", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: { keys: ["permissions", "hooks"] } } })
  );

  const liveFile = path.join(sb.wormHome, ".claude", "settings.json");
  const canonFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(liveFile), { recursive: true });
  await mkdir(path.dirname(canonFile), { recursive: true });
  await writeFile(liveFile, JSON.stringify({ permissions: {} }));
  // As if another machine pushed its hook through the worm repo.
  await writeFile(
    canonFile,
    JSON.stringify({
      permissions: {},
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bash from-other-machine.sh" }] }] },
    })
  );

  await sb.worm(["hook", "trigger", "--global", "session-start"]);

  const live = JSON.parse(await readFile(liveFile, "utf8"));
  assert.equal(live.hooks.Stop[0].hooks[0].command, "bash from-other-machine.sh", "hook landed locally");
});

test("notifyPendingInput runs through the global dispatch and exits cleanly (no fire on sub-agent events)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  // A custom `openOnClick` exercises the configurable click-target.
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { notifyPendingInput: { openOnClick: "Cursor" } } })
  );

  // A sub-agent payload (agent_id present) → the script reads stdin and returns
  // BEFORE notifying. Proves the dispatch routes + forwards stdin without firing
  // a real notification during the suite.
  const r = await sb.worm(["hook", "trigger", "--global", "stop"], {
    input: JSON.stringify({ hook_event_name: "Stop", agent_id: "abc" }),
  });
  assert.equal(r.exitCode, 0, r.stderr);
});

test("notifyPendingInput suppresses mid-turn Stops from background agents, fires on the final response", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { notifyPendingInput: {} } })
  );

  // Build a transcript mirroring a /review turn: a real user prompt, then 4
  // background agents launched. The launch message carries a parenthetical
  // metadata note between "successfully." and "agentId:" — the current shape,
  // which a `\s*` match between the two would miss, wrongly letting every
  // intermediate Stop notify.
  const launchText = (id) =>
    `Async agent launched successfully. (This tool result is internal metadata — never quote it.)\n` +
    `agentId: ${id} (internal ID - do not mention to user.)\nThe agent is working in the background.`;
  const ids = ["a11111111111111a1", "a22222222222222a2", "a33333333333333a3", "a44444444444444a4"];
  const lines = [
    { type: "user", cwd: sb.projectRoot, message: { role: "user", content: [{ type: "text", text: "review PR 1433" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Launching 4 agents." }] } },
    ...ids.map((id) => ({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: launchText(id) }] }] },
    })),
  ];
  const transcript = path.join(sb.wormHome, "transcript.jsonl");
  await writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const sink = path.join(sb.wormHome, "notifications.jsonl");
  const stopPayload = { hook_event_name: "Stop", cwd: sb.projectRoot, transcript_path: transcript };

  // Mid-turn Stop: agents still pending (no completions) → suppressed.
  const mid = await sb.worm(["hook", "trigger", "--global", "stop"], {
    input: JSON.stringify(stopPayload),
    env: { WORM_NOTIFY_SINK: sink },
  });
  assert.equal(mid.exitCode, 0, mid.stderr);
  await assert.rejects(readFile(sink), "mid-turn Stop must not notify");

  // Now all 4 agents complete and the main agent writes a long final synthesis.
  const doneLines = [
    ...ids.map((id) => ({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>` }] },
    })),
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Synthesis of all four reviews: ".padEnd(250, "x") }] },
    },
  ];
  await writeFile(
    transcript,
    [...lines, ...doneLines].map((l) => JSON.stringify(l)).join("\n") + "\n"
  );

  const done = await sb.worm(["hook", "trigger", "--global", "stop"], {
    input: JSON.stringify(stopPayload),
    env: { WORM_NOTIFY_SINK: sink },
  });
  assert.equal(done.exitCode, 0, done.stderr);
  const fired = (await readFile(sink, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(fired.length, 1, "final response fires exactly one notification");
  assert.match(fired[0].message, /Response ready/);
});

test("notifyPendingInput: a background agent's hand-back does not re-anchor the turn", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { notifyPendingInput: {} } })
  );

  // A background agent reports back through an injected `type: "user"` record
  // (`turnOrigin: "peer"`), which looks exactly like a prompt the human typed.
  // Counting it as one would move the turn anchor PAST the launch records, lose
  // the background state, and let every agent completion fire "Response ready".
  const launchText = (id) =>
    `Async agent launched successfully. (internal metadata)\nagentId: ${id} (internal ID)`;
  const ids = ["a11111111111111a1", "a22222222222222a2"];
  const handback = (id) => ({
    type: "user",
    isMeta: true,
    turnOrigin: "peer",
    origin: { kind: "peer", from: id, senderTaskId: id, handback: true },
    promptSource: "system",
    cwd: sb.projectRoot,
    message: {
      role: "user",
      content: `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] Review findings…`,
    },
  });
  const base = [
    {
      type: "user",
      turnOrigin: "human",
      origin: { kind: "human" },
      cwd: sb.projectRoot,
      message: { role: "user", content: [{ type: "text", text: "review PR 1433" }] },
    },
    ...ids.map((id) => ({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: launchText(id) }] }] },
    })),
    handback(ids[0]),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Agent 1 reported. Waiting on agent 2." }] } },
  ];
  const transcript = path.join(sb.wormHome, "transcript.jsonl");
  const write = (lines) => writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await write(base);

  const sink = path.join(sb.wormHome, "notifications.jsonl");
  const stopPayload = { hook_event_name: "Stop", cwd: sb.projectRoot, transcript_path: transcript };
  const stop = () =>
    sb.worm(["hook", "trigger", "--global", "stop"], {
      input: JSON.stringify(stopPayload),
      env: { WORM_NOTIFY_SINK: sink },
    });

  const mid = await stop();
  assert.equal(mid.exitCode, 0, mid.stderr);
  await assert.rejects(readFile(sink), "a hand-back mid-turn must not notify");

  // The last agent hands back and the main agent writes the synthesis. The
  // hand-back counts as that agent's completion — its <task-notification> only
  // lands after this Stop, so waiting for it would swallow the real answer.
  await write([
    ...base,
    handback(ids[1]),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Synthesis: ".padEnd(250, "x") }] } },
  ]);

  const done = await stop();
  assert.equal(done.exitCode, 0, done.stderr);
  const fired = (await readFile(sink, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(fired.length, 1, "exactly one notification, on the synthesis");
  assert.equal(fired[0].title, `Claude Code — ${path.basename(sb.projectRoot)}`);
});

test("notifyPendingInput stays quiet for a nested agent's report after the answer went out", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { notifyPendingInput: {} } })
  );

  // Agents nest: a /review agent spawns its own background agents, and those
  // grandchildren hand back to THIS session — it owns the whole tree — carrying
  // ids it never launched. They keep arriving long after the synthesis went out,
  // and each one is a full report, so neither "nothing pending" nor "the text is
  // long" can tell them from the answer. The launched set can.
  const ours = "a11111111111111a1";
  const nested = "a99999999999999a9";
  const launch = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          content: [{ type: "text", text: `Async agent launched successfully. (metadata)\nagentId: ${ours} (internal ID)` }],
        },
      ],
    },
  };
  const handback = (id) => ({
    type: "user",
    turnOrigin: "peer",
    origin: { kind: "peer", from: id, senderTaskId: id, handback: true },
    cwd: sb.projectRoot,
    message: { role: "user", content: `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] Findings…` },
  });
  const notice = (id) => ({
    type: "user",
    turnOrigin: "task_notification",
    origin: { kind: "task-notification" },
    cwd: sb.projectRoot,
    message: { role: "user", content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` },
  });
  const says = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

  const answered = [
    { type: "user", turnOrigin: "human", origin: { kind: "human" }, cwd: sb.projectRoot, message: { role: "user", content: [{ type: "text", text: "review PR 1433" }] } },
    launch,
    says("Agent launched."),
    handback(ours),
    says("The review: ".padEnd(400, "x")),
  ];
  const transcript = path.join(sb.wormHome, "transcript.jsonl");
  const write = (lines) => writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const sink = path.join(sb.wormHome, "notifications.jsonl");
  const stop = () =>
    sb.worm(["hook", "trigger", "--global", "stop"], {
      input: JSON.stringify({ hook_event_name: "Stop", cwd: sb.projectRoot, transcript_path: transcript }),
      env: { WORM_NOTIFY_SINK: sink },
    });

  await write(answered);
  const answer = await stop();
  assert.equal(answer.exitCode, 0, answer.stderr);
  assert.equal((await readFile(sink, "utf8")).trim().split("\n").length, 1, "the synthesis notifies");

  // The notice trailing our own agent's hand-back repeats what already arrived.
  await write([...answered, notice(ours), says("Already covered above. ".padEnd(400, "x"))]);
  const trailing = await stop();
  assert.equal(trailing.exitCode, 0, trailing.stderr);
  assert.equal((await readFile(sink, "utf8")).trim().split("\n").length, 1, "the trailing notice adds nothing");

  // A grandchild reports: this turn never launched it, so its addendum is not
  // the answer — the answer went out with its parent's report.
  await write([...answered, notice(ours), says("Already covered."), handback(nested), says("An addendum: ".padEnd(900, "x"))]);
  const grandchild = await stop();
  assert.equal(grandchild.exitCode, 0, grandchild.stderr);
  assert.equal((await readFile(sink, "utf8")).trim().split("\n").length, 1, "a nested agent's report must not notify");
});

test("notifyPendingInput names the worktree the turn is in, not the slot it opened in nor a subfolder", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await sb.worm(["init"]);
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { notifyPendingInput: { openOnClick: "Cursor" } } })
  );

  // A session that started in slot 0 and was later resumed in slot 1: the
  // transcript keeps recording, so its OPENING cwd names the slot the work has
  // left. Every record carries the live cwd — prompts included, so a `Bash cd`
  // in one turn leaks into the next prompt. The newest prompt taken at a
  // worktree root is the one that survives both.
  const slot0 = await realpath(sb.projectRoot);
  const slot1 = wtPath(slot0, "feature-a");
  const drifted = path.join(slot1, "src");
  const prompt = (cwd, text) => ({
    type: "user",
    cwd,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const lines = [
    prompt(slot0, "start here"),
    { type: "assistant", cwd: slot0, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    prompt(slot1, "continue over here"),
    { type: "assistant", cwd: drifted, message: { role: "assistant", content: [{ type: "text", text: "moved into src" }] } },
    prompt(drifted, "same window, the shell just wandered"),
    { type: "assistant", cwd: drifted, message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  const transcript = path.join(sb.wormHome, "transcript.jsonl");
  await writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const sink = path.join(sb.wormHome, "notifications.jsonl");
  const r = await sb.worm(["hook", "trigger", "--global", "stop"], {
    // The payload's own cwd is the drifted one — the transcript must win.
    input: JSON.stringify({ hook_event_name: "Stop", cwd: drifted, transcript_path: transcript }),
    env: { WORM_NOTIFY_SINK: sink },
  });
  assert.equal(r.exitCode, 0, r.stderr);

  const fired = JSON.parse((await readFile(sink, "utf8")).trim());
  assert.equal(fired.title, `Claude Code — ${path.basename(slot1)}`, "labelled with the current worktree");
  assert.equal(fired.focusPath, slot1, "click focuses the worktree, not the subfolder the shell wandered to");
});

test("worm detach is reversible: delete the local file and sync re-links it", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [".env"], hooks: {} })
  );
  await sb.worm(["init", "--template", templateDir]);
  const name = path.basename(sb.projectRoot);
  await writeFile(path.join(sb.wormHome, "projects", name, ".env"), "SHARED=1\n");
  const root = await realpath(sb.projectRoot);

  await sb.worm(["detach", ".env"]);
  await assert.rejects(readlink(path.join(root, ".env")), "detached → real file");

  // Re-attach by removing the local file, then syncing.
  await rm(path.join(root, ".env"));
  const r = await sb.worm(["sync"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const link = await readlink(path.join(root, ".env")); // tunnel restored
  assert.match(link, /projects\/.+\/\.env$/);
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "SHARED=1\n");
});

// --- Claude Code's WorktreeCreate / WorktreeRemove hooks ----------------------

test("hook worktree-create: stdout is only the path; setup output goes to stderr; idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  await writeFile(setupPath, '#!/usr/bin/env bash\necho "installing deps for $WORM_WORKTREE_NAME"\n');
  await chmod(setupPath, 0o755);
  const root = await realpath(sb.projectRoot);

  const payload = { hook_event_name: "WorktreeCreate", name: "brave-otter-1a2b", cwd: root, session_id: "s" };
  const r = await sb.worm(["hook", "worktree-create"], { input: JSON.stringify(payload) });
  assert.equal(r.exitCode, 0, r.stderr);
  const wt = wtPath(root, "brave-otter-1a2b");
  assert.equal(r.stdout, wt, "stdout carries the path and nothing else (execa strips the newline)");
  assert.match(r.stderr, /installing deps for brave-otter-1a2b/, "setup ran, its output on stderr");
  const branch = await execa("git", ["branch", "--show-current"], { cwd: wt });
  assert.equal(branch.stdout, "worktree-brave-otter-1a2b", "Claude's naming convention for a fresh name");
  await stat(path.join(wt, ".worktree-keep"));

  // Same name again (e.g. a resumed session) → the existing worktree, no re-setup.
  const again = await sb.worm(["hook", "worktree-create"], { input: JSON.stringify(payload) });
  assert.equal(again.stdout, wt);
  assert.doesNotMatch(again.stderr, /installing deps/);
});

test("hook worktree-create: a name that is a branch checks that branch out", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await sb.worm(["init"]);
  const root = await realpath(sb.projectRoot);
  const r = await sb.worm(["hook", "worktree-create"], {
    input: JSON.stringify({ hook_event_name: "WorktreeCreate", name: "feature-a", cwd: root }),
  });
  assert.equal(r.exitCode, 0, r.stderr);
  const branch = await execa("git", ["branch", "--show-current"], { cwd: r.stdout.trim() });
  assert.equal(branch.stdout, "feature-a");
});

test("hook worktree-remove removes the worktree; refuses main; ignores a missing path", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await sb.worm(["init"]);
  await sb.worm(["worktree", "add", "feature-a", "--no-setup"]);
  const root = await realpath(sb.projectRoot);
  const wt = wtPath(root, "feature-a");
  await writeFile(path.join(wt, "wip.txt"), "x\n"); // Claude already asked about discarding

  const rm1 = await sb.worm(["hook", "worktree-remove"], {
    input: JSON.stringify({ hook_event_name: "WorktreeRemove", worktree_path: wt, cwd: wt }),
  });
  assert.equal(rm1.exitCode, 0, rm1.stderr);
  assert.equal(rm1.stdout, "");
  await assert.rejects(stat(wt), /ENOENT/);

  const main = await sb.worm(["hook", "worktree-remove"], {
    input: JSON.stringify({ hook_event_name: "WorktreeRemove", worktree_path: root }),
  });
  assert.equal(main.exitCode, 0);
  assert.match(main.stderr, /refusing to remove the main worktree/);
  await stat(path.join(root, ".git"));

  const gone = await sb.worm(["hook", "worktree-remove"], {
    input: JSON.stringify({ hook_event_name: "WorktreeRemove", worktree_path: wt }),
  });
  assert.equal(gone.exitCode, 0, "an already-removed worktree is not an error");
});

test("worktree hooks are worm's: syncGlobalPermissions never copies them; old per-worktree copies are stripped", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { syncGlobalPermissions: { keys: "*" } } })
  );
  assert.equal((await sb.worm(["sync", "--global"])).exitCode, 0);
  const canonicalFile = path.join(sb.wormHome, "shared", ".claude", "settings.json");
  await mkdir(path.dirname(canonicalFile), { recursive: true });
  await writeFile(canonicalFile, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  const r = await sb.worm(["hook", "trigger", "--global", "session-end"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const canonical = JSON.parse(await readFile(canonicalFile, "utf8"));
  assert.equal(canonical.hooks?.WorktreeCreate, undefined, "never synced into the canonical copy");

  // A worktree wired by an earlier build carried its own copy: a re-sync removes it.
  const localFile = path.join(sb.projectRoot, ".claude", "settings.local.json");
  await mkdir(path.dirname(localFile), { recursive: true });
  await writeFile(
    localFile,
    JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [{ type: "command", command: "worm hook worktree-create" }] }] } })
  );
  await sb.worm(["sync"]);
  const local = JSON.parse(await readFile(localFile, "utf8"));
  assert.equal(local.hooks?.WorktreeCreate, undefined);
});

test("worktree hooks in a repo worm doesn't manage: Claude's default layout, nothing wired", async (t) => {
  const sb = await createSandbox(); // projectRoot is a plain clone of seedRepo — never `worm init`ed
  t.after(() => sb.cleanup());
  const root = await realpath(sb.projectRoot);
  await execa("git", ["remote", "set-head", "origin", "main"], { cwd: root });

  const create = await sb.worm(["hook", "worktree-create"], {
    input: JSON.stringify({ hook_event_name: "WorktreeCreate", name: "calm-heron", cwd: root }),
  });
  assert.equal(create.exitCode, 0, create.stderr);
  const wt = wtPath(root, "calm-heron");
  assert.equal(create.stdout, wt);
  const branch = await execa("git", ["branch", "--show-current"], { cwd: wt });
  assert.equal(branch.stdout, "worktree-calm-heron");
  const head = await execa("git", ["rev-parse", "HEAD"], { cwd: wt });
  assert.equal(head.stdout, (await execa("git", ["rev-parse", "origin/main"], { cwd: root })).stdout);
  await assert.rejects(stat(path.join(wt, ".worktree-keep")), /ENOENT/, "not wired");
  await assert.rejects(stat(path.join(root, ".worm")), /ENOENT/, "not bound");
  const st = await execa("git", ["status", "--porcelain"], { cwd: root });
  assert.equal(st.stdout, "", ".claude/worktrees is excluded");

  const again = await sb.worm(["hook", "worktree-create"], {
    input: JSON.stringify({ hook_event_name: "WorktreeCreate", name: "calm-heron", cwd: root }),
  });
  assert.equal(again.stdout, wt, "idempotent");

  const remove = await sb.worm(["hook", "worktree-remove"], {
    input: JSON.stringify({ hook_event_name: "WorktreeRemove", worktree_path: wt }),
  });
  assert.equal(remove.exitCode, 0, remove.stderr);
  await assert.rejects(stat(wt), /ENOENT/);
  const kept = await execa("git", ["branch", "--list", "worktree-calm-heron"], { cwd: root });
  assert.match(kept.stdout, /worktree-calm-heron/, "branch kept");

  const outside = await sb.worm(["hook", "worktree-create"], {
    cwd: tmpdir(),
    input: JSON.stringify({ hook_event_name: "WorktreeCreate", name: "x", cwd: tmpdir() }),
  });
  assert.notEqual(outside.exitCode, 0, "outside a git repo the hook fails, as Claude would");
});

// --- sync: project.json and the VS Code workspace ----------------------------

test("sync writes project.json and a workspace file whose folders it never rewrites", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  const r = await sb.worm(["sync"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const root = await realpath(sb.projectRoot);
  const name = path.basename(sb.projectRoot);
  const profile = path.join(sb.wormHome, "projects", name);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, "project.json"), "utf8")), { root });

  const wsFile = path.join(profile, `${name}.code-workspace`);
  const ws = JSON.parse(await readFile(wsFile, "utf8"));
  assert.deepEqual(ws, { folders: [{ path: root }] }, "no window.title: the user's own setting applies");

  // VS Code swaps folder 0 to show a worktree and saves it: sync keeps that,
  // and drops the window title earlier versions wrote.
  ws.folders = [{ path: wtPath(root, "x") }];
  ws.settings = {
    "editor.tabSize": 2,
    "window.title": `${name} · \${rootName}\${separator}\${activeEditorShort}`,
  };
  await writeFile(wsFile, JSON.stringify(ws));
  await sb.worm(["sync"]);
  const after = JSON.parse(await readFile(wsFile, "utf8"));
  assert.deepEqual(after.folders, [{ path: wtPath(root, "x") }]);
  assert.deepEqual(after.settings, { "editor.tabSize": 2 });
});

test('notifyPendingInput openOnClick "claude-desktop" opens the conversation via claude://resume', async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);
  await writeFile(
    path.join(sb.wormHome, "config.json"),
    JSON.stringify({ recipes: { notifyPendingInput: { openOnClick: "claude-desktop" } } })
  );
  const root = await realpath(sb.projectRoot);
  const transcript = path.join(sb.wormHome, "transcript.jsonl");
  await writeFile(
    transcript,
    [
      { type: "user", cwd: root, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "assistant", cwd: root, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n"
  );
  const sink = path.join(sb.wormHome, "notifications.jsonl");
  const session = "6afd0806-7bbf-4328-846e-d4edc525fbb3";
  const r = await sb.worm(["hook", "trigger", "--global", "stop"], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, transcript_path: transcript, session_id: session }),
    env: { WORM_NOTIFY_SINK: sink },
  });
  assert.equal(r.exitCode, 0, r.stderr);
  const fired = JSON.parse((await readFile(sink, "utf8")).trim());
  assert.equal(fired.clickUrl, `claude://resume?session=${session}`);
  assert.equal(fired.focusApp, "");
});
