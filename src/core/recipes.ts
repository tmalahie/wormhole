import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  fs,
  isSymlink,
  pathExists,
  readJson,
  writeJson,
  writeTextIfMissing,
} from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { ensureSymlink } from "./symlinks.js";
import { globalProjectFile, localLogsDir, localRecipeDir, localRecipesRoot } from "./paths.js";
import type {
  RecipesConfig,
  SandboxRecipeConfig,
  ShareHistoryRecipeConfig,
  SyncPermissionsRecipeConfig,
} from "../types.js";

/**
 * The recipe engine. A "recipe" is a composable capability (provider-style):
 * enabled iff its key is present in the project's `recipes` config. Each recipe
 * contributes (1) artifacts materialized under `.worm/recipes/<name>/` and
 * (2) per-slot Claude Code hook entries merged into each slot's
 * `.claude/settings.local.json`. The engine iterates the enabled set; recipes
 * compose because the settings merge namespaces each entry by the recipe-owned
 * `.worm/recipes/` path, so re-running strips and re-adds only worm's entries
 * and never touches a user's own hooks.
 */
export interface RecipeArtifact {
  /** Path relative to `.worm/recipes/<name>/`. */
  relPath: string;
  content: string;
  executable?: boolean;
}

/** Claude hook-event name (PreToolUse / SessionStart / SessionEnd / …) → entries. */
export type SettingsContribution = Record<string, unknown[]>;

/** Minimal slot shape the wiring needs (UniverseSlot satisfies it). */
export interface WiringSlot {
  name: string;
  path: string;
}

export interface RecipeWireContext {
  slot0Root: string;
  projectName: string;
  slot: WiringSlot;
}

export interface Recipe<C = unknown> {
  readonly name: string;
  /** This recipe's config slice, or undefined when it's disabled. */
  select(recipes: RecipesConfig): C | undefined;
  /** Files to write under `.worm/recipes/<name>/`. */
  artifacts?(projectName: string, cfg: C): RecipeArtifact[];
  /** Hook entries to merge into a slot's settings.local.json. */
  wireSlot?(ctx: RecipeWireContext, cfg: C): SettingsContribution;
  /** Imperative per-slot setup (idempotent), run when a slot is wired. */
  onSlotCreate?(ctx: RecipeWireContext, cfg: C): Promise<void>;
}

// --- the sandbox recipe (currently the only built-in) -----------------------

const sandboxRecipe: Recipe<SandboxRecipeConfig> = {
  name: "sandbox",
  select: (recipes) => recipes.sandbox,
  artifacts(projectName, cfg) {
    return [
      { relPath: "Dockerfile", content: renderDockerfile(cfg) },
      { relPath: "compose.yml", content: renderCompose(projectName, cfg) },
      { relPath: "redirect-to-sandbox.js", content: INTERCEPTOR_SCRIPT, executable: true },
      {
        relPath: "sandbox-policy.json",
        content:
          JSON.stringify({ neverSandbox: cfg.neverSandbox, exemptDirs: cfg.exemptDirs }, null, 2) +
          "\n",
      },
    ];
  },
  wireSlot({ slot0Root, projectName, slot }, cfg) {
    const dir = localRecipeDir(slot0Root, "sandbox");
    const compose = path.join(dir, "compose.yml");
    const script = path.join(dir, "redirect-to-sandbox.js");
    const container = `${projectName}-${slot.name}-sandbox`;
    const project = `${projectName}-${slot.name}`;
    // The interceptor's stdout IS the permission decision, so it logs its own
    // decisions to a file rather than being output-redirected.
    const log = path.join(localLogsDir(slot0Root), `${container}.log`);
    const block: SettingsContribution = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `node "${script}" "${container}" "${compose}"` }],
        },
      ],
    };
    if (cfg.autostart) {
      const up = `SANDBOX_DIR="${slot.path}" SANDBOX_CONTAINER="${container}" docker compose -p "${project}" -f "${compose}" up -d`;
      block.SessionStart = [{ hooks: [{ type: "command", command: logged(up, log, "up") }] }];
    }
    if (cfg.autostop) {
      const down = `docker compose -p "${project}" -f "${compose}" down`;
      block.SessionEnd = [{ hooks: [{ type: "command", command: logged(down, log, "down") }] }];
    }
    return block;
  },
};

/**
 * Wrap a hook command so its stdout+stderr append to `logFile` under a dated
 * banner. POSIX-sh only (`{ …; } >>file 2>&1`), so it runs under whatever shell
 * Claude invokes hooks with. `\n` survives to the generated JSON and printf
 * turns it into a real newline at run time. The log dir is created by
 * `materializeRecipes`, since the shell opens the `>>` redirect before the body.
 */
function logged(command: string, logFile: string, label: string): string {
  return `{ printf '\\n=== %s ${label} ===\\n' "$(date '+%FT%T')"; ${command}; } >> "${logFile}" 2>&1`;
}

// --- the syncPermissions recipe ---------------------------------------------
// Unions the `permissions` block of each slot's settings.local.json with a
// canonical store shared across slots (so approving a command in one slot
// teaches them all). It contributes SessionStart + SessionEnd hooks running a
// merge-preserving script — only `permissions` is synced; `hooks` (e.g. the
// sandbox recipe's) are left intact, which is what lets the two recipes share
// the same settings.local.json.

const syncPermissionsRecipe: Recipe<SyncPermissionsRecipeConfig> = {
  name: "syncPermissions",
  select: (recipes) => recipes.syncPermissions,
  artifacts() {
    return [
      { relPath: "sync-claude-settings.js", content: SYNC_PERMISSIONS_SCRIPT, executable: true },
    ];
  },
  wireSlot({ slot0Root, projectName }) {
    const dir = localRecipeDir(slot0Root, "syncPermissions");
    const script = path.join(dir, "sync-claude-settings.js");
    // The canonical union store lives in the PERSISTENT global profile (in
    // ~/.worm — committed, shared across slots, surviving re-clones), NOT the
    // ephemeral local .worm/recipes/. It's also where a user's accumulated
    // allowlist already lives, so existing permissions are pulled in on first run.
    const canonical = globalProjectFile(projectName, path.join(".claude", "settings.local.json"));
    const command = `node "${script}" "${canonical}"`;
    const entry = { hooks: [{ type: "command", command }] };
    // Same bidirectional sync on both boundaries: pull on start, push on end.
    return { SessionStart: [entry], SessionEnd: [entry] };
  },
};

// --- the shareHistory recipe -------------------------------------------------
// Symlinks each sibling slot's Claude history dir to Slot 0's canonical one, so
// every slot shares one conversation history. Purely imperative (onSlotCreate)
// — no artifacts, no settings hooks. (Lifts the `ln -sfn` block that used to
// live in projects' setup.sh into a first-class recipe.)

/** Claude's project-history slug: the absolute path with `/` and `.` → `-`. */
function claudeSlug(absPath: string): string {
  return path.resolve(absPath).replace(/[/.]/g, "-");
}

const shareHistoryRecipe: Recipe<ShareHistoryRecipeConfig> = {
  name: "shareHistory",
  select: (recipes) => recipes.shareHistory,
  async onSlotCreate({ slot, slot0Root }) {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    const canonicalSlug = claudeSlug(slot0Root);
    const slotSlug = claudeSlug(slot.path);
    if (slotSlug === canonicalSlug) return; // Slot 0 *is* the canonical store.

    const linkPath = path.join(projectsDir, slotSlug);
    if ((await pathExists(linkPath)) && !(await isSymlink(linkPath))) {
      logger.warn(
        `${slot.name}: ${linkPath} is a real history dir — merge it into ${canonicalSlug}/ by hand; skipping.`
      );
      return;
    }
    const res = await ensureSymlink(linkPath, path.join(projectsDir, canonicalSlug), {
      relative: true,
      type: "dir",
    });
    if (res.created) logger.step(`🔗 ${slot.name}: Claude history → ${canonicalSlug}`);
  },
};

const REGISTRY: Recipe<any>[] = [sandboxRecipe, syncPermissionsRecipe, shareHistoryRecipe];

function enabledRecipes(recipes: RecipesConfig): Array<{ recipe: Recipe<any>; cfg: unknown }> {
  const out: Array<{ recipe: Recipe<any>; cfg: unknown }> = [];
  for (const recipe of REGISTRY) {
    const cfg = recipe.select(recipes);
    if (cfg !== undefined) out.push({ recipe, cfg });
  }
  return out;
}

// --- artifact materialization ------------------------------------------------

/**
 * Materialize every enabled recipe's artifacts under `.worm/recipes/<name>/`.
 * Idempotent and non-clobbering (`writeTextIfMissing`) — once generated, the
 * files are the user's to edit, mirroring how `setup.sh` is owned after seeding.
 * Returns the `<name>/<relPath>` of each file actually written.
 */
export async function materializeRecipes(
  slot0Root: string,
  projectName: string,
  recipes: RecipesConfig
): Promise<string[]> {
  const written: string[] = [];
  const enabled = enabledRecipes(recipes);
  // Pre-create the log dir so the hooks' `>> .worm/logs/…` redirects don't fail
  // (the shell opens the redirect before the command body runs).
  if (enabled.length > 0) await ensureDir(localLogsDir(slot0Root));
  for (const { recipe, cfg } of enabled) {
    const artifacts = recipe.artifacts?.(projectName, cfg) ?? [];
    if (artifacts.length === 0) continue;
    const dir = localRecipeDir(slot0Root, recipe.name);
    await ensureDir(dir);
    for (const artifact of artifacts) {
      const filePath = path.join(dir, artifact.relPath);
      if (await writeTextIfMissing(filePath, artifact.content)) {
        if (artifact.executable) await fs.chmod(filePath, 0o755);
        written.push(`${recipe.name}/${artifact.relPath}`);
      }
    }
  }
  return written;
}

// --- per-slot Claude Code hook wiring (.claude/settings.local.json) ----------

/** Install (or, when no recipes are enabled, strip) recipe hooks for one slot. */
export async function applyRecipeWiring(
  slot0Root: string,
  projectName: string,
  slot: WiringSlot,
  recipes: RecipesConfig
): Promise<boolean> {
  const ctx: RecipeWireContext = { slot0Root, projectName, slot };
  const install: SettingsContribution = {};
  for (const { recipe, cfg } of enabledRecipes(recipes)) {
    // Imperative per-slot setup (e.g. shareHistory's symlink) runs first.
    if (recipe.onSlotCreate) await recipe.onSlotCreate(ctx, cfg);
    const contribution = recipe.wireSlot?.(ctx, cfg);
    if (!contribution) continue;
    for (const [event, entries] of Object.entries(contribution)) {
      if (!entries || entries.length === 0) continue;
      (install[event] ??= []).push(...entries);
    }
  }
  return writeSlotHooks(slot0Root, slot.path, install);
}

/** Remove all worm-managed recipe hooks from a slot (used on `destroy`). */
export async function stripRecipeWiring(slot0Root: string, slotPath: string): Promise<boolean> {
  return writeSlotHooks(slot0Root, slotPath, {});
}

function isWormManaged(entry: unknown, marker: string): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (h) =>
        typeof (h as { command?: unknown })?.command === "string" &&
        (h as { command: string }).command.includes(marker)
    )
  );
}

/**
 * Merge `install` into a slot's `.claude/settings.local.json` (gitignored by
 * convention, so worm never dirties a tracked repo). worm owns only the hook
 * entries it recognises — their commands reference the `.worm/recipes/` tree —
 * so on each run it strips its previous entries and re-adds `install`, leaving
 * every other hook and key (and other recipes' entries) intact. Pass an empty
 * `install` to strip. Idempotent. Returns whether the file changed.
 */
async function writeSlotHooks(
  slot0Root: string,
  slotPath: string,
  install: SettingsContribution
): Promise<boolean> {
  const settingsPath = path.join(slotPath, ".claude", "settings.local.json");
  const marker = localRecipesRoot(slot0Root);
  const existed = await pathExists(settingsPath);
  let settings: Record<string, any> = {};
  if (existed) {
    try {
      settings = await readJson<Record<string, any>>(settingsPath);
    } catch {
      settings = {};
    }
  }
  const before = JSON.stringify(settings);

  const hooksRoot: Record<string, any[]> =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  // Reconcile every event present in either the existing file or the install set,
  // so a recipe can contribute any hook event without a hardcoded list.
  const events = new Set<string>([...Object.keys(hooksRoot), ...Object.keys(install)]);
  for (const event of events) {
    const prev = Array.isArray(hooksRoot[event]) ? hooksRoot[event] : [];
    const keep = prev.filter((entry) => !isWormManaged(entry, marker));
    const next = keep.concat((install[event] as unknown[]) ?? []);
    if (next.length > 0) hooksRoot[event] = next;
    else delete hooksRoot[event];
  }
  if (Object.keys(hooksRoot).length > 0) settings.hooks = hooksRoot;
  else delete settings.hooks;

  if (JSON.stringify(settings) === before) return false;
  // Don't create an empty settings.local.json just to write `{}`.
  if (!existed && Object.keys(settings).length === 0) return false;
  await ensureDir(path.dirname(settingsPath));
  await writeJson(settingsPath, settings);
  return true;
}

// --- sandbox artifact renderers ----------------------------------------------

function renderDockerfile(cfg: SandboxRecipeConfig): string {
  const lines = [
    `# Sandbox image generated by worm. Edit freely — it won't be regenerated.`,
    `FROM ${cfg.image}`,
    "",
  ];
  if (cfg.tools.length > 0) {
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${cfg.tools.join(" ")} \\`,
      `    && rm -rf /var/lib/apt/lists/*`,
      ""
    );
  }
  lines.push(`CMD ["sleep", "infinity"]`, "");
  return lines.join("\n");
}

function renderCompose(projectName: string, cfg: SandboxRecipeConfig): string {
  void cfg;
  // `\${VAR}` emits a literal `${VAR}` for compose to interpolate at run time.
  return `# Long-running sandbox container generated by worm.
# Start a slot's sandbox:  SANDBOX_DIR=<slot path> docker compose -p ${projectName}-<N> -f .worm/recipes/sandbox/compose.yml up -d
# $SANDBOX_DIR is the worktree to mount (set per slot by worm's session wiring).
# $SANDBOX_CONTAINER overrides the container name (defaults to ${projectName}-sandbox).
name: ${projectName}-sandbox

services:
  sandbox:
    build:
      context: .
      dockerfile: Dockerfile
    image: ${projectName}-sandbox:latest
    container_name: \${SANDBOX_CONTAINER:-${projectName}-sandbox}
    restart: unless-stopped
    working_dir: \${SANDBOX_DIR:?set SANDBOX_DIR to the slot worktree path}
    volumes:
      - \${SANDBOX_DIR}:\${SANDBOX_DIR}
    command: ["sleep", "infinity"]
`;
}

// Embedded via String.raw so the `'\n'` literals survive as backslash-n in the
// generated file (a normal template literal would turn them into real newlines).
// Contains no backticks and no `${...}`.
const SYNC_PERMISSIONS_SCRIPT = String.raw`#!/usr/bin/env node
// SessionStart/SessionEnd hook generated by worm (syncPermissions recipe).
// Bidirectionally unions the 'permissions' block of this slot's
// .claude/settings.local.json with a canonical store shared by every slot, so
// approving a command in one slot teaches them all. ONLY 'permissions' is
// synced — 'hooks' and any other keys (e.g. the sandbox recipe's) are preserved
// untouched in each file, so recipes share settings.local.json without clobber.
//
// Usage (from settings.local.json):  node sync-claude-settings.js <canonicalFile>
const fs = require('fs');
const path = require('path');

const canonicalFile = process.argv[2];
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const worktreeFile = path.join(projectDir, '.claude', 'settings.local.json');
if (!canonicalFile) process.exit(0);

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function unionArrays(a, b) {
  const seen = new Set();
  const out = [];
  for (const value of [].concat(a || [], b || [])) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) { seen.add(key); out.push(value); }
  }
  return out;
}

function mergePermissions(canon, local) {
  canon = canon || {};
  local = local || {};
  const out = Object.assign({}, canon);
  for (const key of new Set([].concat(Object.keys(canon), Object.keys(local)))) {
    const cv = canon[key];
    const lv = local[key];
    if (Array.isArray(cv) || Array.isArray(lv)) {
      out[key] = unionArrays(Array.isArray(cv) ? cv : [], Array.isArray(lv) ? lv : []);
    } else if (cv === undefined) {
      out[key] = lv;
    }
  }
  return out;
}

function writeIfChanged(filePath, obj) {
  const content = JSON.stringify(obj, null, 2) + '\n';
  let current = null;
  try { current = fs.readFileSync(filePath, 'utf8'); } catch (e) {}
  if (current === content) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

const canon = readJson(canonicalFile) || {};
const local = readJson(worktreeFile) || {};
const merged = mergePermissions(canon.permissions, local.permissions);
if (Object.keys(merged).length === 0) process.exit(0); // nothing to sync yet

// Merge-preserving: keep each file's other keys, sync only 'permissions'.
const wroteLocal = writeIfChanged(worktreeFile, Object.assign({}, local, { permissions: merged }));
const wroteCanon = writeIfChanged(canonicalFile, Object.assign({}, canon, { permissions: merged }));
if (wroteLocal || wroteCanon) {
  try {
    const logDir = path.join(__dirname, '..', '..', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const n = Array.isArray(merged.allow) ? merged.allow.length : 0;
    const line = '[' + new Date().toISOString() + '] synced ' + n + ' allow rules (' + worktreeFile + ')\n';
    fs.appendFileSync(path.join(logDir, 'sync-permissions.log'), line);
  } catch (e) { /* logging is best-effort */ }
}
`;

// The interceptor is embedded via String.raw so its regex backslashes survive
// (a normal template literal would mangle `\s`, `\d`, …). It contains no
// backticks and no `${...}`, so String.raw reproduces it verbatim. Policy
// (neverSandbox / exemptDirs) is read at run time from the sibling
// sandbox-policy.json, so the script itself is config-independent.
const INTERCEPTOR_SCRIPT = String.raw`#!/usr/bin/env node
// PreToolUse(Bash) hook generated by worm. Denies filesystem-mutating commands
// and ad-hoc script runs on the host, redirecting them into a long-running
// docker sandbox whose blast radius is limited to the mounted worktree.
//
// Usage (from settings.local.json):  node redirect-to-sandbox.js <container> <composePath>
// Policy is read from the sibling sandbox-policy.json. Append ' #bypass-hook'
// to any command to run it on the host anyway.
const fs = require('fs');
const path = require('path');

const containerName = process.argv[2] || 'sandbox';
const composePath = process.argv[3] || '';
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let policy = { neverSandbox: ['npm', 'npx', 'pnpm', 'yarn'], exemptDirs: [] };
try {
  policy = JSON.parse(fs.readFileSync(path.join(__dirname, 'sandbox-policy.json'), 'utf8'));
} catch (e) { /* fall back to defaults */ }

function logDecision(decision, cmd) {
  try {
    const dir = path.join(__dirname, '..', '..', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = '[' + new Date().toISOString() + '] ' + decision + ' ' + cmd.replace(/\n/g, ' ') + '\n';
    fs.appendFileSync(path.join(dir, containerName + '-redirect.log'), line);
  } catch (e) { /* logging must never break the decision */ }
}

const FILE_OPS = new Set(['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'truncate', 'shred', 'install']);
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'perl', 'ruby', 'php']);
const NODE_TOOLS = new Set(policy.neverSandbox || []);

const SCRIPT_TOKEN = /(?:^|[\s='"(])((?:\.{1,2}\/|\/)?[^\s'"()]*\.(?:sh|bash|zsh|py|rb|pl|php)|\.{1,2}\/[^\s'"()]+)(?=$|[\s'")])/;
const READONLY_CHECK = /\bphp\s+-l\b/;

const exemptNames = ['worm', 'claude'].concat(policy.exemptDirs || []);
// Matches a path token whose component is .worm/ .claude/ (or a configured
// exempt dir), in any form: bare ./relative, ~/-rooted, or absolute.
const EXCLUDED_DIR = new RegExp('(?:^|[\\s=\'"(])(?:[^\\s\'"]*/)?\\.(?:' + exemptNames.join('|') + ')/');

function allow() { process.exit(0); }

function deny() {
  const startHint = composePath
    ? '\n\nIf the container is not running, start it:\n  docker compose -f ' + composePath + ' up -d'
    : '';
  const reason =
    'This command mutates the filesystem or runs an ad-hoc script on the host. ' +
    'Run it inside the \'' + containerName + '\' docker sandbox instead (already up), so its blast radius is ' +
    'limited to the mounted worktree. Re-run it as (wrap your command in single quotes):\n' +
    '  docker exec ' + containerName + ' bash -lc \'<your original command>\'\n\n' +
    'The sandbox mounts ' + projectDir + ' read-write at the same absolute path.' +
    startHint +
    '\n\nAppend \' #bypass-hook\' to run on the host anyway.';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function baseName(token) { const parts = token.split('/'); return parts[parts.length - 1]; }

// Blank the INTERIOR of single/double-quoted spans (preserving length and the
// quote chars), so shell operators and file-op words inside string literals —
// commit messages, --body text, jq filters — can't be misread as command
// boundaries or programs. Positions are preserved so callers can slice raw.
function maskQuotedSpans(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote !== null) {
      if (ch === quote) { quote = null; out += ch; } else { out += ' '; }
    } else if (ch === '"' || ch === "'") {
      quote = ch; out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// Split on unquoted ; && || and newlines: find the operators in the masked
// string (quoted ones are blanked, so ignored), then slice the RAW command at
// those offsets. Analysing the raw segment keeps quoted script PATHS visible to
// SCRIPT_TOKEN while never splitting inside a quote.
function splitRespectingQuotes(command) {
  const masked = maskQuotedSpans(command);
  const re = /\n|;|&&|\|\|/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(masked)) !== null) {
    out.push(command.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(command.slice(last));
  return out;
}

function shouldRedirect(command) {
  if (/#bypass-hook\s*$/.test(command)) return false;
  if (/^\s*(?:sudo\s+)?docker(?:\s|-compose\b|$)/.test(command)) return false;
  for (let segment of splitRespectingQuotes(command)) {
    segment = segment.trim();
    if (!segment) continue;
    // Exempt a segment that runs a script under an exempt dir (.worm/.claude/…).
    // Per-SEGMENT (not whole-command) so one exempt clause can't shield a sibling
    // file-op; masked so a quoted path can't spuriously exempt one either.
    if (EXCLUDED_DIR.test(maskQuotedSpans(segment))) continue;
    segment = segment.replace(/^(?:\w+=(?:'[^']*'|"[^"]*"|\S+)\s+)*/, '').replace(/^sudo\s+/, '');
    const firstToken = segment.split(/\s+/)[0] || '';
    if (!firstToken) continue;
    const program = baseName(firstToken);
    if (NODE_TOOLS.has(program)) continue;
    // node executes arbitrary code (a script, -e/-p, or stdin), so sandbox it
    // unless neverSandbox exempts it (handled above) — except pure inspection
    // flags that don't run user code.
    if (program === 'node') {
      if (/\s--(?:version|check|help)\b|\s-v\b/.test(' ' + segment)) continue;
      return true;
    }
    if (INTERPRETERS.has(program) && READONLY_CHECK.test(segment)) continue;
    if (FILE_OPS.has(program)) return true;
    if (/^(?:\.{1,2}\/|\/)?[^\s]*\.(?:sh|bash|zsh|py|rb|pl|php)$/.test(firstToken)) return true;
    if (INTERPRETERS.has(program) && SCRIPT_TOKEN.test(segment)) return true;
  }
  return false;
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let command = '';
  try { command = (JSON.parse(input).tool_input || {}).command || ''; } catch (e) { allow(); }
  if (!command) allow();
  if (shouldRedirect(command)) { logDecision('DENY ', command); deny(); }
  logDecision('allow', command); allow();
});
`;
