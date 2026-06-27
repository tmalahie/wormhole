import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readlink, realpath, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { execa } from "execa";
import { createBranch, createSandbox, PACKAGED_RECIPES } from "./helpers.mjs";

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

test("worm init binds Slot 0: symlinks, excludes .worm, seeds manifest, idempotent", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const r1 = await sb.worm(["init"]);
  assert.equal(r1.exitCode, 0, r1.stderr);
  assert.match(r1.stdout, /is now bound as Slot 0/);

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
  assert.match(r.stdout, /alias: worm tp 1/, "introduces the teleport shortcut");

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

  // Slot 0 links straight at the profile source (absolute; the .worm/shared
  // two-hop is gone).
  const slot0Link = await readlink(path.join(sb.projectRoot, ".env"));
  assert.ok(path.isAbsolute(slot0Link), "slot links are absolute");
  assert.match(slot0Link, /projects\/.+\/\.env$/);

  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const sibLink = await readlink(path.join(siblingPath(root, 1), ".env"));
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
  const add = await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  assert.equal(add.exitCode, 0, add.stderr);
  const root = await realpath(sb.projectRoot);

  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "projects", name, "config.json");
  await writeFile(cfgPath, JSON.stringify({ shared_paths: ["shared.txt"], hooks: {} }));

  // Two slots each hold a real, differing file at the same shared path.
  await writeFile(path.join(root, "shared.txt"), "slot0\n");
  await writeFile(path.join(siblingPath(root, 1), "shared.txt"), "slot1\n");

  const r = await sb.worm(["sync", "--yes"]);
  assert.notEqual(r.exitCode, 0, "should refuse rather than silently overwrite one");
  assert.match(r.stderr, /multiple slots/);

  // Both copies survive untouched.
  assert.equal(await readFile(path.join(root, "shared.txt"), "utf8"), "slot0\n");
  assert.equal(await readFile(path.join(siblingPath(root, 1), "shared.txt"), "utf8"), "slot1\n");
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

test("sandbox wiring installs the static dispatcher entry; container is computed fresh per slot", async (t) => {
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

  // A sibling slot computes its OWN container name from the SAME dispatcher entry.
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const s1 = await readLocal(siblingPath(root, 1));
  assert.match(s1.hooks.PreToolUse[0].hooks[0].command, /hook trigger pre-tool-use/);
  const d1 = await sb.worm(["hook", "trigger", "pre-tool-use"], {
    cwd: siblingPath(root, 1),
    input: denyIn,
  });
  assert.match(d1.stdout, new RegExp(`${escapeRegex(name)}-1-sandbox`));

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

  const run = await execa("node", [script, canonical], {
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

const claudeSlug = (p) => p.replace(/[/.]/g, "-");

test("shareHistory recipe links a sibling's Claude history to Slot 0's", async (t) => {
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

  // Slot 0 is the canonical store — worm must not create a self-symlink for it.
  await assert.rejects(
    stat(path.join(projectsDir, claudeSlug(root))),
    /ENOENT/,
    "Slot 0 is not self-linked"
  );

  // A sibling's history dir becomes a relative symlink to Slot 0's slug.
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const link = path.join(projectsDir, claudeSlug(siblingPath(root, 1)));
  assert.equal(await readlink(link), claudeSlug(root), "relative symlink → Slot 0 slug");
});

test("shareHistory refuses to clobber a real history dir", async (t) => {
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
  const realDir = path.join(sb.wormHome, ".claude", "projects", claudeSlug(siblingPath(root, 1)));
  await mkdir(realDir, { recursive: true });
  await writeFile(path.join(realDir, "session.jsonl"), "{}\n");

  const r = await sb.worm(["universe", "add", "feature-b", "--skip-hook"]);
  assert.equal(r.exitCode, 0, "real dir is a warning, not a fatal error");
  // The real dir and its contents survive untouched.
  await stat(path.join(realDir, "session.jsonl"));
  assert.match(r.stderr + r.stdout, /real history dir/);
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
  const prevCwd = siblingPath(sb.projectRoot, 1);
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
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const sibMemory = path.join(projectsDir, claudeSlug(siblingPath(root, 1)), "memory");
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
    sb.wormHome, ".claude", "projects", claudeSlug(siblingPath(root, 1)), "memory"
  );
  await mkdir(sibReal, { recursive: true });
  await writeFile(path.join(sibReal, "keep.md"), "x\n");

  const r = await sb.worm(["universe", "add", "feature-b", "--skip-hook"]);
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

test("universe add --create spins up a missing branch", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  const r = await sb.worm(["universe", "add", "feat/new", "--create", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /created branch/);

  const root = await realpath(sb.projectRoot);
  assert.ok((await stat(siblingPath(root, 1))).isDirectory());
  const state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.ok(state.slots.some((s) => s.branch === "feat/new"), "branch is checked out in a slot");
});

test("universe add on a missing branch errors in a non-interactive shell (no --create)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  // No TTY in tests → the prompt is skipped and the original error stands.
  const r = await sb.worm(["universe", "add", "ghost", "--skip-hook"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /does not exist/);
  assert.match(r.stderr, /--create/);
});

test("worm cd / worm tp without shell-init explain how to enable it", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  // When the shell function is installed it intercepts cd/tp before the binary;
  // reaching the binary means the integration is missing → a helpful error.
  for (const alias of ["cd", "tp"]) {
    const r = await sb.worm([alias, "0"]);
    assert.notEqual(r.exitCode, 0, `${alias} should error without shell integration`);
    assert.match(r.stderr, /shell integration/);
    assert.match(r.stderr, /worm shell-init/);
  }
});

test("worm switch --create makes a missing branch in place", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init"]);

  const r = await sb.worm(["switch", "feat/x", "--create", "--skip-hook"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /created branch/);

  const state = JSON.parse((await sb.worm(["status", "--json"])).stdout);
  assert.equal(state.slots[0].branch, "feat/x");
});

test("on_create hook runs setup.sh with WORM_* env vars on universe add", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  await sb.worm(["init"]);

  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  await writeFile(
    setupPath,
    `#!/usr/bin/env bash\necho "ROOT=$WORM_PROJECT_ROOT"\necho "SLOT=$WORM_SLOT"\necho "INDEX=$WORM_SLOT_INDEX"\necho "BRANCH=$WORM_BRANCH"\necho "WT=$WORM_WORKTREE"\necho "PROFILE=$WORM_PROFILE"\n`
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
  // WORM_PROFILE points at the durable profile dir (<WORM_HOME>/projects/<name>).
  const profile = path.join(sb.wormHome, "projects", path.basename(sb.projectRoot));
  assert.match(r.stdout, new RegExp(`PROFILE=${escapeRegex(profile)}`));
});

test("on_create hook warms Slot 0 on init; --skip-hook opts out", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  await sb.worm(["init"]);

  // Replace the default (comment-only) setup.sh with one that echoes the env.
  const setupPath = path.join(sb.projectRoot, ".worm", "scripts", "setup.sh");
  await writeFile(
    setupPath,
    `#!/usr/bin/env bash\necho "ROOT=$WORM_PROJECT_ROOT"\necho "SLOT=$WORM_SLOT"\necho "INDEX=$WORM_SLOT_INDEX"\necho "BRANCH=$WORM_BRANCH"\necho "WT=$WORM_WORKTREE"\n`
  );
  await chmod(setupPath, 0o755);

  // Re-running init is the "create" event for Slot 0, so the hook fires there.
  const r = await sb.worm(["init", "--force"]);
  assert.equal(r.exitCode, 0, r.stderr);
  const root = await realpath(sb.projectRoot);
  assert.match(r.stdout, new RegExp(`ROOT=${escapeRegex(root)}`));
  assert.match(r.stdout, /SLOT=main/);
  assert.match(r.stdout, /INDEX=0/);
  assert.match(r.stdout, /BRANCH=main/);
  assert.match(r.stdout, new RegExp(`WT=${escapeRegex(root)}`));

  // --skip-hook suppresses the warm-up while still re-binding cleanly.
  const skipped = await sb.worm(["init", "--force", "--skip-hook"]);
  assert.equal(skipped.exitCode, 0, skipped.stderr);
  assert.doesNotMatch(skipped.stdout, /INDEX=0/);
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

// Mirrors core/env.ts:stableHash/portOffset — pins the stable-port contract so a
// hash-algorithm change is a conscious, test-breaking decision (a given branch
// must always map to the same port).
function portOffset(branch) {
  let h = 0x811c9dc5;
  for (let i = 0; i < branch.length; i++) {
    h ^= branch.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000;
}

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

test("env: generates a per-worktree dotenv with stable per-branch ports, gitignored", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      shared_paths: [],
      env: {
        file: ".env.worm",
        vars: { PORT: "{{ 8080 + offset }}", SLOT: "{{ slot }}", BRANCH: "{{ branch }}" },
      },
      hooks: {},
    })
  );

  await sb.worm(["init", "--template", templateDir]);

  const slot0 = parseDotenv(await readFile(path.join(sb.projectRoot, ".env.worm"), "utf8"));
  assert.equal(slot0.SLOT, "main");
  assert.equal(slot0.BRANCH, "main");
  assert.equal(slot0.PORT, String(8080 + portOffset("main")));

  // The generated file must be git-excluded (never shows up as untracked).
  const status = await execa(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: sb.projectRoot }
  );
  assert.doesNotMatch(status.stdout, /\.env\.worm/, "generated env file must be git-excluded");

  // A sibling on another branch gets its own, branch-derived values.
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const sib = parseDotenv(await readFile(path.join(siblingPath(root, 1), ".env.worm"), "utf8"));
  assert.equal(sib.SLOT, "1");
  assert.equal(sib.BRANCH, "feature-a");
  assert.equal(sib.PORT, String(8080 + portOffset("feature-a")));
});

test("env: values are stable per branch across re-sync and switch", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");
  await createBranch(sb.projectRoot, "feature-b");

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  // `file` omitted → defaults to .env.worm.
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], env: { vars: { PORT: "{{ 3000 + offset }}" } }, hooks: {} })
  );

  await sb.worm(["init", "--template", templateDir]);
  const envPath = path.join(sb.projectRoot, ".env.worm");
  const first = await readFile(envPath, "utf8");

  // Re-sync must not churn the file (declarative, content-stable).
  await sb.worm(["sync"]);
  assert.equal(await readFile(envPath, "utf8"), first, "sync must not rewrite an unchanged env file");

  // The port follows the BRANCH, not the slot — switching reproduces it.
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const sibEnv = path.join(siblingPath(root, 1), ".env.worm");
  const portA = parseDotenv(await readFile(sibEnv, "utf8")).PORT;
  assert.equal(portA, String(3000 + portOffset("feature-a")));

  await sb.worm(["switch", "feature-b", "--skip-hook"], { cwd: siblingPath(root, 1) });
  assert.equal(
    parseDotenv(await readFile(sibEnv, "utf8")).PORT,
    String(3000 + portOffset("feature-b"))
  );

  await sb.worm(["switch", "feature-a", "--skip-hook"], { cwd: siblingPath(root, 1) });
  assert.equal(parseDotenv(await readFile(sibEnv, "utf8")).PORT, portA, "same branch → same port");
});

test("env: a file also listed in shared_paths is refused with a hint", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  // Start clean (no collision) so init succeeds.
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      shared_paths: [".env"],
      env: { file: ".env.worm", vars: { PORT: "{{ 8080 + offset }}" } },
      hooks: {},
    })
  );
  await sb.worm(["init", "--template", templateDir]);

  // Make env.file collide with the shared_path, then sync.
  const name = path.basename(sb.projectRoot);
  const cfgPath = path.join(sb.wormHome, "projects", name, "config.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      shared_paths: [".env"],
      env: { file: ".env", vars: { PORT: "{{ 8080 + offset }}" } },
      hooks: {},
    })
  );

  const r = await sb.worm(["sync"]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /also listed in shared_paths/);
});

test("env: an unknown {{ … }} expression fails cleanly", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], env: { vars: { X: "{{ bogus }}" } }, hooks: {} })
  );

  const r = await sb.worm(["init", "--template", templateDir]);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /unknown variable/);
});

test("env: index-based offset gives clean sequential ports (front/back per worktree)", async (t) => {
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await createBranch(sb.projectRoot, "feature-a");

  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  // The arcads-monorepo convention: front 3000 / back 3001, +10000 per slot.
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({
      shared_paths: [],
      env: {
        vars: { FRONT: "{{ 3000 + index * 10000 }}", BACK: "{{ 3001 + index * 10000 }}" },
      },
      hooks: {},
    })
  );

  await sb.worm(["init", "--template", templateDir]);
  const slot0 = parseDotenv(await readFile(path.join(sb.projectRoot, ".env.worm"), "utf8"));
  assert.equal(slot0.FRONT, "3000");
  assert.equal(slot0.BACK, "3001");

  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const sib = parseDotenv(await readFile(path.join(siblingPath(root, 1), ".env.worm"), "utf8"));
  assert.equal(sib.FRONT, "13000");
  assert.equal(sib.BACK, "13001");
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
      env: { vars: { PORT: "{{ 8080 + offset }}" } },
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
  const env = parseDotenv(await readFile(path.join(extReal, ".env.worm"), "utf8"));
  assert.equal(env.PORT, String(8080 + portOffset("feature-a")), "branch-stable env generated");

  // Idempotent.
  const r2 = await sb.worm(["wire", extPath]);
  assert.equal(r2.exitCode, 0, r2.stderr);
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
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);

  // Detach .env in Slot 0 (cwd defaults to projectRoot).
  const r = await sb.worm(["detach", ".env"]);
  assert.equal(r.exitCode, 0, r.stderr);

  // Slot 0: now a real file with the copied content; the sibling keeps the link.
  await assert.rejects(readlink(path.join(root, ".env")), "Slot 0 .env is no longer a symlink");
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "SHARED=1\n");
  await readlink(path.join(siblingPath(root, 1), ".env")); // resolves → still a tunnel

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
  // GLOBAL scope only — never wired into a project slot.
  await assert.rejects(stat(path.join(sb.projectRoot, ".claude", "settings.local.json")), /ENOENT/);

  // Removing it from the global config + re-syncing strips the hooks.
  await writeFile(path.join(sb.wormHome, "config.json"), JSON.stringify({}));
  await sb.worm(["sync", "--global"]);
  const s2 = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.ok(!s2.hooks?.Stop, "autosync hooks stripped after removal");
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

test("syncGlobalPermissions merges the global permissions block bidirectionally", async (t) => {
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
