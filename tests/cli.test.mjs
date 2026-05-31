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

test("recipes: empty provisions nothing; sandbox generates Dockerfile + compose", async (t) => {
  // Default recipes are empty → no recipes dir.
  const sbNone = await createSandbox();
  t.after(() => sbNone.cleanup());
  await sbNone.worm(["init"]);
  await assert.rejects(
    stat(path.join(sbNone.projectRoot, ".worm", "recipes")),
    /ENOENT/,
    "no enabled recipe → nothing written"
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

test("sandbox wiring writes idempotent per-slot hooks into settings.local.json", async (t) => {
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

  const name = path.basename(sb.projectRoot);
  const sandboxDir = path.join(sb.projectRoot, ".worm", "recipes", "sandbox");
  const readLocal = async (dir) =>
    JSON.parse(await readFile(path.join(dir, ".claude", "settings.local.json"), "utf8"));

  // Interceptor + policy generated — and the interceptor is valid JS (it's
  // embedded via String.raw and the suite otherwise never executes it).
  const interceptor = path.join(sandboxDir, "redirect-to-sandbox.js");
  await stat(interceptor);
  const check = await execa("node", ["--check", interceptor], { reject: false });
  assert.equal(check.exitCode, 0, `generated interceptor must be valid JS:\n${check.stderr}`);
  const policy = JSON.parse(await readFile(path.join(sandboxDir, "sandbox-policy.json"), "utf8"));
  assert.ok(Array.isArray(policy.neverSandbox));

  // Slot 0 wired in settings.local.json (the gitignored target).
  const s0 = await readLocal(sb.projectRoot);
  assert.equal(s0.hooks.PreToolUse.length, 1);
  assert.equal(s0.hooks.PreToolUse[0].matcher, "Bash");
  assert.match(s0.hooks.PreToolUse[0].hooks[0].command, new RegExp(`${escapeRegex(name)}-main-sandbox`));
  assert.match(s0.hooks.PreToolUse[0].hooks[0].command, /redirect-to-sandbox\.js/);
  assert.ok(Array.isArray(s0.hooks.SessionStart), "autostart default → SessionStart present");

  // A new universe gets its own container name in its own settings.local.json.
  await sb.worm(["universe", "add", "feature-a", "--skip-hook"]);
  const root = await realpath(sb.projectRoot);
  const s1 = await readLocal(siblingPath(root, 1));
  assert.match(s1.hooks.PreToolUse[0].hooks[0].command, new RegExp(`${escapeRegex(name)}-1-sandbox`));

  // Idempotent: a re-sync must not duplicate Slot 0's hook entry.
  await sb.worm(["sync"]);
  const s0b = await readLocal(sb.projectRoot);
  assert.equal(s0b.hooks.PreToolUse.length, 1, "re-sync must not duplicate worm hooks");
});

test("syncPermissions recipe wires session hooks and a valid merge script", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { syncPermissions: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const script = path.join(
    sb.projectRoot, ".worm", "recipes", "syncPermissions", "sync-claude-settings.js"
  );
  const check = await execa("node", ["--check", script], { reject: false });
  assert.equal(check.exitCode, 0, `generated sync script must be valid JS:\n${check.stderr}`);

  const s0 = JSON.parse(
    await readFile(path.join(sb.projectRoot, ".claude", "settings.local.json"), "utf8")
  );
  assert.equal(s0.hooks.SessionStart.length, 1);
  const cmd = s0.hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, /sync-claude-settings\.js/);
  assert.equal(s0.hooks.SessionEnd.length, 1);
  assert.match(s0.hooks.SessionEnd[0].hooks[0].command, /sync-claude-settings\.js/);

  // Canonical store is the PERSISTENT global profile (committed in ~/.worm),
  // not the ephemeral local .worm/recipes/ — so existing allowlists are pulled in.
  const canonical = path.join(
    sb.wormHome, "multiverses", path.basename(sb.projectRoot), ".claude", "settings.local.json"
  );
  assert.ok(cmd.includes(`"${canonical}"`), `canonical must be the global profile file:\n${cmd}`);
  assert.doesNotMatch(cmd, /recipes\/syncPermissions\/permissions\.json/);
});

test("recipes compose: sandbox + syncPermissions share settings.local.json", async (t) => {
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
  // PreToolUse: sandbox only.
  assert.equal(s0.hooks.PreToolUse.length, 1);
  assert.match(s0.hooks.PreToolUse[0].hooks[0].command, /redirect-to-sandbox\.js/);
  // SessionStart: BOTH recipes coexist (container up + permission sync).
  assert.equal(s0.hooks.SessionStart.length, 2, "both recipes contribute SessionStart");
  const startCmds = s0.hooks.SessionStart.map((e) => e.hooks[0].command).join("\n");
  assert.match(startCmds, /docker compose .* up -d/);
  assert.match(startCmds, /sync-claude-settings\.js/);
  // SessionEnd: syncPermissions (autostop default off → no sandbox down).
  assert.equal(s0.hooks.SessionEnd.length, 1);
  assert.match(s0.hooks.SessionEnd[0].hooks[0].command, /sync-claude-settings\.js/);

  // Idempotent: re-sync must not duplicate either recipe's entries.
  await sb.worm(["sync"]);
  const s0b = await readLocal();
  assert.equal(s0b.hooks.SessionStart.length, 2, "re-sync must not duplicate");
  assert.equal(s0b.hooks.PreToolUse.length, 1);
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

  const recipeDir = path.join(sb.projectRoot, ".worm", "recipes", "syncPermissions");
  const script = path.join(recipeDir, "sync-claude-settings.js");
  const canonical = path.join(recipeDir, "permissions.json");

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

test("recipe hooks log to .worm/logs", async (t) => {
  const templateDir = await mkdtemp(path.join(tmpdir(), "worm-tmpl-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(
    path.join(templateDir, "config.json"),
    JSON.stringify({ shared_paths: [], hooks: {}, recipes: { sandbox: {} } })
  );
  const sb = await createSandbox();
  t.after(() => sb.cleanup());
  await sb.worm(["init", "--template", templateDir]);

  const root = await realpath(sb.projectRoot); // init canonicalizes via realpath
  const name = path.basename(root);
  const container = `${name}-main-sandbox`;
  const logsDir = path.join(root, ".worm", "logs");

  // init pre-creates the log dir so the docker `>>` redirect can't fail at runtime.
  assert.equal((await stat(logsDir)).isDirectory(), true);

  // SessionStart redirects docker output to a per-container log file.
  const s0 = JSON.parse(
    await readFile(path.join(root, ".claude", "settings.local.json"), "utf8")
  );
  const startCmd = s0.hooks.SessionStart[0].hooks[0].command;
  assert.match(startCmd, /docker compose .* up -d/);
  assert.ok(
    startCmd.includes(`>> "${path.join(logsDir, `${container}.log`)}" 2>&1`),
    `SessionStart must redirect to the container log:\n${startCmd}`
  );

  // The interceptor records its decisions to <container>-redirect.log.
  const interceptor = path.join(root, ".worm", "recipes", "sandbox", "redirect-to-sandbox.js");
  await execa("node", [interceptor, container, "/x/compose.yml"], {
    input: JSON.stringify({ tool_input: { command: "rm -rf /tmp/zzz" } }),
    reject: false,
  });
  const redirectLog = await readFile(path.join(logsDir, `${container}-redirect.log`), "utf8");
  assert.match(redirectLog, /DENY .*rm -rf \/tmp\/zzz/);
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
  const interceptor = path.join(sandboxDir, "redirect-to-sandbox.js");
  const decide = async (command) => {
    const r = await execa("node", [interceptor, "c", "/x/compose.yml"], {
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
  const cfgPath = path.join(sb.wormHome, "multiverses", name, "config.json");

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
