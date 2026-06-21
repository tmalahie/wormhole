import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  fs,
  isSymlink,
  pathExists,
  readJson,
  readText,
  writeJson,
  writeTextIfMissing,
} from "../utils/fs.js";
import { runShell } from "../utils/exec.js";
import { renderTemplate } from "../utils/template.js";
import { logger } from "../utils/logger.js";
import { ensureSymlink } from "./symlinks.js";
import { hookEnv } from "./hooks.js";
import {
  globalProjectFile,
  globalProjectMemoryDir,
  globalRoot,
  localLogsDir,
  localRecipeDir,
  packagedRecipeScript,
  packagedRecipeTemplate,
} from "./paths.js";
import type {
  AutosyncConfig,
  NotifyPendingInputRecipeConfig,
  RecipesConfig,
  SandboxRecipeConfig,
  ShareHistoryRecipeConfig,
  ShareMemoryRecipeConfig,
  SyncGlobalPermissionsRecipeConfig,
  SyncPermissionsRecipeConfig,
  UniverseSlot,
} from "../types.js";

/**
 * The recipe engine. A "recipe" is a composable capability (provider-style):
 * enabled iff its key is present in the project's `recipes` config. Each recipe
 * contributes (1) artifacts materialized under `.worm/recipes/<name>/` and
 * (2) hook commands run by the dispatcher.
 *
 * Hooks are INVERTED: a slot's `.claude/settings.local.json` holds ONE static
 * entry per hook event — `node "<cli>" hook trigger <event>` — installed once.
 * At trigger time the dispatcher (`runRecipeHooks` / `runRecipeFilters` /
 * `runRecipeContext`, invoked by `worm hook trigger`) resolves the live slot,
 * asks each enabled recipe for
 * its commands for that event, injects env (the WORM_* vars + WORM_LOG_DIR), and
 * owns logging. So enabling/disabling/updating a recipe is a pure config change —
 * settings.local.json never churns, and identifiers can't go stale.
 *
 * Worm-OWNED code (the sandbox interceptor, the permission-sync script) is
 * config-independent and so lives ONCE in the package (see `packagedRecipeScript`)
 * rather than being copied per project — it is parameterized at run time via
 * args + env. Only genuinely per-project files (Dockerfile, compose, policy) are
 * materialized as artifacts.
 */
export interface RecipeArtifact {
  /** Path relative to `.worm/recipes/<name>/`. */
  relPath: string;
  content: string;
  executable?: boolean;
}

/** Claude hook-event key (PreToolUse / SessionStart / SessionEnd) → entries. */
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
  /**
   * "project" (default) → wired per-slot by `worm sync` / `universe add` into
   * each slot's settings.local.json. "global" → machine-wide, declared in
   * ~/.worm/config.json and wired by `worm sync --global` into
   * ~/.claude/settings.json; runs without any project/slot context.
   */
  readonly scope?: "project" | "global";
  /** This recipe's config slice, or undefined when it's disabled. */
  select(recipes: RecipesConfig): C | undefined;
  /** Files to write under `.worm/recipes/<name>/` (may render packaged templates). */
  artifacts?(projectName: string, cfg: C): Promise<RecipeArtifact[]>;
  /** Hook commands this recipe contributes, by event. Computed lazily at trigger
   *  time by the dispatcher (and probed at wiring time to decide which static
   *  dispatcher entries to install). */
  hooks?(ctx: RecipeWireContext, cfg: C): HookContribution;
  /** Imperative per-slot setup (idempotent), run when a slot is wired. */
  onSlotCreate?(ctx: RecipeWireContext, cfg: C): Promise<void>;
}

// --- hook events & the dispatcher contract -----------------------------------

/** worm's normalized hook events (mapped to the agent's settings keys below). */
export type HookEvent =
  | "pre-tool-use"
  | "user-prompt-submit"
  | "session-start"
  | "session-end"
  | "stop"
  | "permission-request";

/**
 * How the dispatcher treats an event's stdin/stdout:
 * - `filter`: reads the tool input on stdin, stdout is a permission decision;
 *   the first `deny` is forwarded to the agent (PreToolUse).
 * - `context`: reads the hook input on stdin, stdout is extra context injected
 *   ahead of the prompt; the dispatcher wraps it in the event's JSON envelope
 *   (UserPromptSubmit).
 * - `run`: fire-and-log, stdout captured to a log file (Session*).
 */
export type HookKind = "filter" | "context" | "run";

interface HookEventMeta {
  /** The Claude Code settings.local.json event key. */
  claudeEvent: string;
  /** Settings matcher (PreToolUse gates Bash); omitted → no matcher. */
  matcher?: string;
  kind: HookKind;
}

export const HOOK_EVENTS: Record<HookEvent, HookEventMeta> = {
  "pre-tool-use": { claudeEvent: "PreToolUse", matcher: "Bash", kind: "filter" },
  "user-prompt-submit": { claudeEvent: "UserPromptSubmit", kind: "context" },
  "session-start": { claudeEvent: "SessionStart", kind: "run" },
  "session-end": { claudeEvent: "SessionEnd", kind: "run" },
  // End of each agent turn — the reliable, frequent push trigger for autosync
  // (SessionEnd is best-effort and never fires for a session that's never closed).
  stop: { claudeEvent: "Stop", kind: "run" },
  // Fires on a permission prompt — used by `notifyPendingInput` ("waiting for
  // approval"). `run` kind: the dispatcher fires it and ignores its output, so it
  // never affects the permission decision.
  "permission-request": { claudeEvent: "PermissionRequest", kind: "run" },
};

/**
 * One command a recipe wants run for a hook event. The command is just the
 * program + args — the DISPATCHER injects env (the WORM_* hook vars +
 * WORM_LOG_DIR) and owns logging, so a recipe never bakes env or `>>` redirects
 * into the string (baking them in is what let the old per-recipe wiring rot).
 */
export interface HookCommand {
  command: string;
  /** Log basename for run-events (defaults to the recipe name). Unused for
   *  filter-events — their stdout IS the decision; they self-log. */
  log?: string;
}
export type HookContribution = Partial<Record<HookEvent, HookCommand[]>>;

// worm's hook-entry marker, for idempotent (re)wiring. Inverted dispatch means
// settings holds ONE static entry per event — `worm hook trigger <event>` —
// recognised by this marker, so re-wiring strips and re-adds only worm's own
// entries (and migrates older `node "<cli>" hook trigger` entries — they match
// the same marker, so a re-sync replaces them with the `worm` form).
const DISPATCH_MARKER = "hook trigger ";

/** The static settings command that routes an event back into worm. Resolved via
 *  `worm` on PATH (not a baked absolute path): the hook was only written because
 *  `worm sync` ran — i.e. `worm` was on PATH — so it stays valid across reinstalls,
 *  moves, and node/nvm version switches that would stale an absolute cli.js path.
 *  The `--global` form runs GLOBAL-scope recipes without resolving a project (used
 *  by the entries `worm sync --global` writes into ~/.claude/settings.json). */
function dispatchCommand(event: HookEvent, opts: { global?: boolean } = {}): string {
  return `worm hook trigger ${opts.global ? "--global " : ""}${event}`;
}

// --- the sandbox recipe (currently the only built-in) -----------------------

const sandboxRecipe: Recipe<SandboxRecipeConfig> = {
  name: "sandbox",
  select: (recipes) => recipes.sandbox,
  async artifacts(projectName, cfg) {
    return [
      { relPath: "Dockerfile", content: await renderDockerfile(cfg) },
      { relPath: "compose.yml", content: await renderCompose(projectName) },
      {
        relPath: "sandbox-policy.json",
        content:
          JSON.stringify({ neverSandbox: cfg.neverSandbox, exemptDirs: cfg.exemptDirs }, null, 2) +
          "\n",
      },
    ];
  },
  hooks({ slot0Root, projectName, slot }, cfg) {
    const dir = localRecipeDir(slot0Root, "sandbox");
    const compose = path.join(dir, "compose.yml");
    const policy = path.join(dir, "sandbox-policy.json");
    // Code lives ONCE in the package; the per-project bits (container, compose,
    // policy) are computed here at trigger time and passed as args.
    const script = packagedRecipeScript("sandbox", "redirect-to-sandbox.js");
    const container = `${projectName}-${slot.name}-sandbox`;
    const project = `${projectName}-${slot.name}`;
    const out: HookContribution = {
      // Filter: the interceptor reads the tool input on stdin and self-logs its
      // decision to <container>-redirect.log (via WORM_LOG_DIR set by dispatch).
      "pre-tool-use": [{ command: `node "${script}" "${container}" "${compose}" "${policy}"`, log: container }],
    };
    if (cfg.autostart) {
      out["session-start"] = [
        {
          command: `SANDBOX_DIR="${slot.path}" SANDBOX_CONTAINER="${container}" docker compose -p "${project}" -f "${compose}" up -d`,
          log: container,
        },
      ];
    }
    if (cfg.autostop) {
      out["session-end"] = [
        { command: `docker compose -p "${project}" -f "${compose}" down`, log: container },
      ];
    }
    return out;
  },
};

/**
 * Wrap a run-event command so its stdout+stderr append to `logFile` under a
 * dated banner. POSIX-sh only (`{ …; } >>file 2>&1`). Owned by the dispatcher
 * (recipes never see this) — the ONE place that knows about hook logging.
 */
function logged(command: string, logFile: string, label: string): string {
  return `{ printf '\\n=== %s ${label} ===\\n' "$(date '+%FT%T')"; ${command}; } >> "${logFile}" 2>&1`;
}

// --- the syncPermissions recipe ---------------------------------------------
// Unions the `permissions` block of each slot's settings.local.json with a
// canonical store shared across slots (so approving a command in one slot
// teaches them all). It contributes session-start + session-end commands running
// a merge-preserving script — only `permissions` is synced; `hooks` (e.g. the
// sandbox recipe's) are left intact, which is what lets the two recipes share
// the same settings.local.json.

const syncPermissionsRecipe: Recipe<SyncPermissionsRecipeConfig> = {
  name: "syncPermissions",
  select: (recipes) => recipes.syncPermissions,
  // No artifacts: the sync script is worm-owned code that lives ONCE in the
  // package (parameterized at run time), never copied into a project.
  hooks({ projectName }) {
    const script = packagedRecipeScript("syncPermissions", "sync-claude-settings.js");
    // The canonical union store lives in the PERSISTENT global profile (in
    // ~/.worm — committed, shared across slots, surviving re-clones), NOT the
    // ephemeral local .worm/recipes/. It's also where a user's accumulated
    // allowlist already lives, so existing permissions are pulled in on first run.
    const canonical = globalProjectFile(projectName, path.join(".claude", "settings.local.json"));
    const command = `node "${script}" "${canonical}"`;
    // Same bidirectional sync on both boundaries: pull on start, push on end.
    return { "session-start": [{ command }], "session-end": [{ command }] };
  },
};

// --- the shareHistory recipe -------------------------------------------------
// Symlinks each sibling slot's Claude history dir to Slot 0's canonical one, so
// every slot shares one conversation history. Purely imperative (onSlotCreate)
// — no artifacts, no hook commands. (Lifts the `ln -sfn` block that used to live
// in projects' setup.sh into a first-class recipe.)

/** Claude's project-history slug: the absolute path with `/` and `.` → `-`. */
function claudeSlug(absPath: string): string {
  return path.resolve(absPath).replace(/[/.]/g, "-");
}

const shareHistoryRecipe: Recipe<ShareHistoryRecipeConfig> = {
  name: "shareHistory",
  select: (recipes) => recipes.shareHistory,
  // Every slot shares ONE history, so a single chat can hop between worktrees as
  // you `worm switch`. This UserPromptSubmit hook warns the model when the
  // conversation's cwd changes between prompts. Worm-owned, config-independent
  // code → packaged once, not copied per project (like the sandbox interceptor).
  hooks() {
    const script = packagedRecipeScript("shareHistory", "inject-cwd-on-switch.js");
    return { "user-prompt-submit": [{ command: `node "${script}"` }] };
  },
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

// --- the shareMemory recipe --------------------------------------------------
// Links every slot's Claude *memory* dir at ONE canonical store in the PROFILE
// (~/.worm/projects/<name>/.claude/memory), so all slots read & write one
// shared memory that survives a slot-0 reclone. Unlike shareHistory — whose
// canonical store IS Slot 0, so Slot 0 is left alone — the store here lives in
// the profile, so Slot 0 is linked too. Purely imperative (onSlotCreate).

/** Move a real `memory/` dir into the profile to seed the shared store, with an
 *  EXDEV fallback (copy+remove) for a profile on a different filesystem. */
async function seedMemory(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

const shareMemoryRecipe: Recipe<ShareMemoryRecipeConfig> = {
  name: "shareMemory",
  select: (recipes) => recipes.shareMemory,
  async onSlotCreate({ slot, projectName }) {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    const slotMemory = path.join(projectsDir, claudeSlug(slot.path), "memory");
    const canonical = globalProjectMemoryDir(projectName);

    if ((await pathExists(slotMemory)) && !(await isSymlink(slotMemory))) {
      // A real memory dir: seed the empty profile store from it on first run,
      // else refuse to clobber — the user merges the two by hand.
      if (await pathExists(canonical)) {
        logger.warn(
          `${slot.name}: ${slotMemory} is a real memory dir — merge it into ${canonical} by hand; skipping.`
        );
        return;
      }
      await seedMemory(slotMemory, canonical);
      logger.step(`🌱 ${slot.name}: seeded shared memory into the profile`);
    } else {
      // Ensure the canonical store exists so the link resolves to a real dir.
      await ensureDir(canonical);
    }

    const res = await ensureSymlink(slotMemory, canonical, { relative: false, type: "dir" });
    if (res.created) logger.step(`🔗 ${slot.name}: Claude memory → profile`);
  },
};

// --- the autosync recipe (GLOBAL scope) --------------------------------------
// Keeps the ~/.worm meta-repo synced across machines. Unlike the others it isn't
// per-slot: it's declared in ~/.worm/config.json and wired by `worm sync --global`
// into ~/.claude/settings.json, so it fires for EVERY Claude session regardless of
// project (even outside a worm repo). Its hooks ignore slot context — the script
// acts on ~/.worm via WORM_HOME. pull on session start; push (debounced) on stop
// (the reliable trigger for an always-open session) + a flush on session end.
const autosyncRecipe: Recipe<AutosyncConfig> = {
  name: "autosync",
  scope: "global",
  select: (recipes) => recipes.autosync,
  hooks(_ctx, cfg) {
    const script = packagedRecipeScript("autosync", "sync-worm-home.js");
    const base = `node "${script}" "${cfg.remote}" "${cfg.debounceMinutes}" "${cfg.notify ? 1 : 0}"`;
    return {
      "session-start": [{ command: `${base} pull`, log: "autosync" }],
      stop: [{ command: `${base} push`, log: "autosync" }],
      "session-end": [{ command: `${base} push`, log: "autosync" }],
    };
  },
};

// --- the notifyPendingInput recipe (GLOBAL scope) --------------------------
// OS notification when the main agent yields to you: "Response ready" on Stop,
// "Waiting for approval" on PermissionRequest. Reads the hook payload on stdin
// (forwarded by the global dispatch), so it can label + focus the right VS Code
// window and debounce background-agent turns. macOS/terminal-notifier flavoured.
const notifyPendingInputRecipe: Recipe<NotifyPendingInputRecipeConfig> = {
  name: "notifyPendingInput",
  scope: "global",
  select: (recipes) => recipes.notifyPendingInput,
  hooks(_ctx, cfg) {
    const script = packagedRecipeScript("notifyPendingInput", "notify-chat-event.js");
    // cfg.openOnClick is read live at trigger time → changes need no re-wire.
    const command = `node "${script}" "${cfg.openOnClick}"`;
    return { stop: [{ command }], "permission-request": [{ command }] };
  },
};

// --- the syncGlobalPermissions recipe (GLOBAL scope) -------------------------
// The global analogue of syncPermissions: version-controls the `permissions` block
// of ~/.claude/settings.json by merging it with a git-tracked canonical copy in
// ~/.worm. Bidirectional + idempotent, so it runs on every session boundary/turn.
const syncGlobalPermissionsRecipe: Recipe<SyncGlobalPermissionsRecipeConfig> = {
  name: "syncGlobalPermissions",
  scope: "global",
  select: (recipes) => recipes.syncGlobalPermissions,
  hooks() {
    const script = packagedRecipeScript("syncGlobalPermissions", "sync-global-settings.js");
    const command = `node "${script}"`;
    return {
      "session-start": [{ command }],
      stop: [{ command }],
      "session-end": [{ command }],
    };
  },
};

// shareMemory is registered AFTER shareHistory so that, when both are enabled, a
// sibling's whole project dir is already a symlink to Slot 0's before shareMemory
// touches its memory subdir (it then resolves to Slot 0's link — a no-op).
const REGISTRY: Recipe<any>[] = [
  sandboxRecipe,
  syncPermissionsRecipe,
  shareHistoryRecipe,
  shareMemoryRecipe,
  autosyncRecipe,
  notifyPendingInputRecipe,
  syncGlobalPermissionsRecipe,
];

function enabledRecipes(
  recipes: RecipesConfig,
  scope: "project" | "global" = "project"
): Array<{ recipe: Recipe<any>; cfg: unknown }> {
  const out: Array<{ recipe: Recipe<any>; cfg: unknown }> = [];
  for (const recipe of REGISTRY) {
    if ((recipe.scope ?? "project") !== scope) continue;
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
  // Pre-create the log dir so the dispatcher's `>> .worm/logs/…` redirects don't
  // fail (the shell opens the redirect before the command body runs).
  if (enabled.length > 0) await ensureDir(localLogsDir(slot0Root));
  for (const { recipe, cfg } of enabled) {
    const artifacts = (await recipe.artifacts?.(projectName, cfg)) ?? [];
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

// --- per-slot hook wiring (installs the static dispatcher entries) -----------

/**
 * Install the dispatcher entries for one slot. Probes which events have at least
 * one enabled-recipe command, then writes ONE static `worm hook trigger <event>`
 * entry per such event into the slot's settings.local.json — the actual commands
 * are NOT baked in; they're recomputed at trigger time. Also runs each recipe's
 * imperative `onSlotCreate`. Returns whether the file changed.
 */
export async function applyRecipeWiring(
  slot0Root: string,
  projectName: string,
  slot: WiringSlot,
  recipes: RecipesConfig
): Promise<boolean> {
  const ctx: RecipeWireContext = { slot0Root, projectName, slot };
  const events = new Set<HookEvent>();
  for (const { recipe, cfg } of enabledRecipes(recipes)) {
    // Imperative per-slot setup (e.g. shareHistory's symlink) runs first.
    if (recipe.onSlotCreate) await recipe.onSlotCreate(ctx, cfg);
    const contribution = recipe.hooks?.(ctx, cfg);
    if (!contribution) continue;
    for (const [event, cmds] of Object.entries(contribution) as Array<
      [HookEvent, HookCommand[] | undefined]
    >) {
      if (cmds && cmds.length > 0) events.add(event);
    }
  }
  const install: SettingsContribution = {};
  for (const event of events) {
    const meta = HOOK_EVENTS[event];
    const entry: Record<string, unknown> = {
      hooks: [{ type: "command", command: dispatchCommand(event) }],
    };
    if (meta.matcher) entry.matcher = meta.matcher;
    (install[meta.claudeEvent] ??= []).push(entry);
  }
  return writeSlotHooks(slot.path, install);
}

/** Remove all worm-managed recipe hooks from a slot (used on `destroy`). */
export async function stripRecipeWiring(slotPath: string): Promise<boolean> {
  return writeSlotHooks(slotPath, {});
}

// --- global (machine-wide) recipe wiring + dispatch --------------------------

/** A context stub for global recipes — they ignore slot info and act on ~/.worm. */
function globalWireContext(): RecipeWireContext {
  return { slot0Root: globalRoot(), projectName: "global", slot: { name: "global", path: globalRoot() } };
}

function globalSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * Wire GLOBAL-scope recipes (currently `autosync`) into ~/.claude/settings.json
 * so they fire for EVERY Claude session, regardless of project. Mirrors
 * `applyRecipeWiring` but writes the user-level settings file with the `--global`
 * dispatch form. An empty/none-enabled recipe set strips worm's entries (so
 * removing `autosync` from ~/.worm/config.json + `worm sync --global` uninstalls).
 * Returns whether the file changed.
 */
export async function applyGlobalRecipeWiring(recipes: RecipesConfig): Promise<boolean> {
  const ctx = globalWireContext();
  const events = new Set<HookEvent>();
  for (const { recipe, cfg } of enabledRecipes(recipes, "global")) {
    const contribution = recipe.hooks?.(ctx, cfg);
    if (!contribution) continue;
    for (const [event, cmds] of Object.entries(contribution) as Array<
      [HookEvent, HookCommand[] | undefined]
    >) {
      if (cmds && cmds.length > 0) events.add(event);
    }
  }
  const install: SettingsContribution = {};
  for (const event of events) {
    const meta = HOOK_EVENTS[event];
    const entry: Record<string, unknown> = {
      hooks: [{ type: "command", command: dispatchCommand(event, { global: true }) }],
    };
    if (meta.matcher) entry.matcher = meta.matcher;
    (install[meta.claudeEvent] ??= []).push(entry);
  }
  return writeHooksFile(globalSettingsPath(), install);
}

/**
 * Run GLOBAL-scope recipes' run-event commands for `event` — invoked by `worm
 * hook trigger --global <event>`, with NO project/slot context (global recipes
 * act on ~/.worm via WORM_HOME). Output surfaces only on a TTY: a hook's stdout
 * would otherwise be injected into the agent's context, and conflicts already
 * surface via the recipe's own marker + OS notification. Never throws.
 */
export async function runGlobalRecipeHooks(
  recipes: RecipesConfig,
  event: HookEvent,
  input = ""
): Promise<void> {
  const ctx = globalWireContext();
  for (const { recipe, cfg } of enabledRecipes(recipes, "global")) {
    const cmds = recipe.hooks?.(ctx, cfg)?.[event] ?? [];
    for (const hc of cmds) {
      // Forward the hook payload on stdin (notifyPendingInput reads it); recipes
      // that don't care (autosync, syncGlobalPermissions) simply ignore it.
      const res = await runShell(hc.command, { cwd: globalRoot(), env: process.env, input });
      if (process.stdout.isTTY) {
        const out = `${res.stdout}${res.stderr}`.trim();
        if (out) process.stdout.write(out + "\n");
      }
    }
  }
}

// --- the dispatcher (invoked by `worm hook trigger <event>`) -----------------

export interface DispatchContext {
  slot0Root: string;
  projectName: string;
  slot: UniverseSlot;
  branch: string;
}

/** The WORM_* + log env the dispatcher injects when running a recipe's command,
 *  so the command string itself stays clean (no baked-in env). */
function dispatchEnv(ctx: DispatchContext, recipe: string, logDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...hookEnv(ctx.slot0Root, ctx.slot, ctx.branch, ctx.projectName),
    WORM_LOG_DIR: logDir,
    WORM_RECIPE: recipe,
  };
}

function wireContext(ctx: DispatchContext): RecipeWireContext {
  return { slot0Root: ctx.slot0Root, projectName: ctx.projectName, slot: ctx.slot };
}

/**
 * Run every enabled recipe's RUN-event commands (session-start/-end) for
 * `event`, each with its output captured to `.worm/logs/<log>.log` under a dated
 * banner. Fire-and-log: one recipe's failure never aborts the others.
 */
export async function runRecipeHooks(
  ctx: DispatchContext,
  recipes: RecipesConfig,
  event: HookEvent
): Promise<void> {
  const logDir = localLogsDir(ctx.slot0Root);
  await ensureDir(logDir);
  for (const { recipe, cfg } of enabledRecipes(recipes)) {
    const cmds = recipe.hooks?.(wireContext(ctx), cfg)?.[event] ?? [];
    for (const hc of cmds) {
      const logFile = path.join(logDir, `${hc.log ?? recipe.name}.log`);
      await runShell(logged(hc.command, logFile, event), {
        cwd: ctx.slot.path,
        env: dispatchEnv(ctx, recipe.name, logDir),
      });
    }
  }
}

/**
 * Run every enabled recipe's FILTER-event commands (pre-tool-use) against the
 * tool input on stdin, returning the first `deny` decision (verbatim, to be
 * written to stdout) or null to allow. Each filter self-logs via WORM_LOG_DIR.
 */
export async function runRecipeFilters(
  ctx: DispatchContext,
  recipes: RecipesConfig,
  event: HookEvent,
  input: string
): Promise<string | null> {
  const logDir = localLogsDir(ctx.slot0Root);
  for (const { recipe, cfg } of enabledRecipes(recipes)) {
    const cmds = recipe.hooks?.(wireContext(ctx), cfg)?.[event] ?? [];
    for (const hc of cmds) {
      const res = await runShell(hc.command, {
        cwd: ctx.slot.path,
        env: dispatchEnv(ctx, recipe.name, logDir),
        input,
      });
      if (res.stdout.includes('"permissionDecision":"deny"')) return res.stdout;
    }
  }
  return null;
}

/**
 * Run every enabled recipe's CONTEXT-event commands (user-prompt-submit) against
 * the hook input on stdin, collecting each command's stdout. Returns the
 * event's JSON envelope wrapping the joined output (the agent injects
 * `additionalContext` ahead of the prompt), or null when nothing was emitted.
 * The dispatcher owns the protocol envelope so recipe scripts only print text.
 */
export async function runRecipeContext(
  ctx: DispatchContext,
  recipes: RecipesConfig,
  event: HookEvent,
  input: string
): Promise<string | null> {
  const logDir = localLogsDir(ctx.slot0Root);
  const parts: string[] = [];
  for (const { recipe, cfg } of enabledRecipes(recipes)) {
    const cmds = recipe.hooks?.(wireContext(ctx), cfg)?.[event] ?? [];
    for (const hc of cmds) {
      const res = await runShell(hc.command, {
        cwd: ctx.slot.path,
        env: dispatchEnv(ctx, recipe.name, logDir),
        input,
      });
      const text = res.stdout.trim();
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENTS[event].claudeEvent,
      additionalContext: parts.join("\n\n"),
    },
  });
}

// worm recognises its own hook entries by the dispatcher marker (see above).
function isWormManaged(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => {
      const cmd = (h as { command?: unknown })?.command;
      return typeof cmd === "string" && cmd.includes(DISPATCH_MARKER);
    })
  );
}

/** Merge `install` into a slot's `.claude/settings.local.json` (gitignored). */
async function writeSlotHooks(
  slotPath: string,
  install: SettingsContribution
): Promise<boolean> {
  return writeHooksFile(path.join(slotPath, ".claude", "settings.local.json"), install);
}

/**
 * Merge `install` into a Claude settings file. worm owns only the hook entries it
 * recognises (see `isWormManaged`) — so on each run it strips its previous entries
 * and re-adds `install`, leaving every other hook and key intact. Pass an empty
 * `install` to strip. Idempotent. Returns whether the file changed. Used for both
 * a slot's settings.local.json and the machine-wide ~/.claude/settings.json.
 */
async function writeHooksFile(
  settingsPath: string,
  install: SettingsContribution
): Promise<boolean> {
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
    const keep = prev.filter((entry) => !isWormManaged(entry));
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

// Both render a packaged `{{var}}` template (real, lintable files under
// dist/recipes/sandbox/templates/). The only conditional logic — the apt-get
// block — is precomputed here and passed as a `{{tools}}` var, so the template
// itself stays pure substitution. compose's literal `${SANDBOX_DIR}` needs no
// escaping now, since `{{…}}` and `${…}` don't collide.

async function renderDockerfile(cfg: SandboxRecipeConfig): Promise<string> {
  const tmpl = await readText(packagedRecipeTemplate("sandbox", "Dockerfile.tmpl"));
  const tools =
    cfg.tools.length > 0
      ? `RUN apt-get update && apt-get install -y --no-install-recommends ${cfg.tools.join(" ")} \\\n` +
        `    && rm -rf /var/lib/apt/lists/*\n\n`
      : "";
  return renderTemplate(tmpl, { image: cfg.image, tools });
}

async function renderCompose(projectName: string): Promise<string> {
  const tmpl = await readText(packagedRecipeTemplate("sandbox", "compose.yml.tmpl"));
  return renderTemplate(tmpl, { project: projectName });
}
