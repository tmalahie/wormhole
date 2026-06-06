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
import { runShell } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { ensureSymlink } from "./symlinks.js";
import { hookEnv } from "./hooks.js";
import {
  globalProjectFile,
  localLogsDir,
  localRecipeDir,
  packagedRecipeScript,
  wormCliEntry,
} from "./paths.js";
import type {
  RecipesConfig,
  SandboxRecipeConfig,
  ShareHistoryRecipeConfig,
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
 * At trigger time the dispatcher (`runRecipeHooks` / `runRecipeFilters`, invoked
 * by `worm hook trigger`) resolves the live slot, asks each enabled recipe for
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
  /** This recipe's config slice, or undefined when it's disabled. */
  select(recipes: RecipesConfig): C | undefined;
  /** Files to write under `.worm/recipes/<name>/`. */
  artifacts?(projectName: string, cfg: C): RecipeArtifact[];
  /** Hook commands this recipe contributes, by event. Computed lazily at trigger
   *  time by the dispatcher (and probed at wiring time to decide which static
   *  dispatcher entries to install). */
  hooks?(ctx: RecipeWireContext, cfg: C): HookContribution;
  /** Imperative per-slot setup (idempotent), run when a slot is wired. */
  onSlotCreate?(ctx: RecipeWireContext, cfg: C): Promise<void>;
}

// --- hook events & the dispatcher contract -----------------------------------

/** worm's normalized hook events (mapped to the agent's settings keys below). */
export type HookEvent = "pre-tool-use" | "session-start" | "session-end";

interface HookEventMeta {
  /** The Claude Code settings.local.json event key. */
  claudeEvent: string;
  /** Settings matcher (PreToolUse gates Bash); omitted → no matcher. */
  matcher?: string;
  /**
   * Filter events read the tool input on stdin and emit a permission decision
   * on stdout (PreToolUse). Run events are fire-and-log (Session*).
   */
  filter: boolean;
}

export const HOOK_EVENTS: Record<HookEvent, HookEventMeta> = {
  "pre-tool-use": { claudeEvent: "PreToolUse", matcher: "Bash", filter: true },
  "session-start": { claudeEvent: "SessionStart", filter: false },
  "session-end": { claudeEvent: "SessionEnd", filter: false },
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

// worm's hook-entry markers, for idempotent (re)wiring. Inverted dispatch means
// settings.local.json holds ONE static entry per event — `node "<cli>" hook
// trigger <event>` — recognised by DISPATCH_MARKER. The LEGACY markers match
// wiring written by older versions (pre-live-once embedded `.worm/recipes/`
// paths; live-once `WORM_RECIPE=` per-recipe commands) so a single `worm sync`
// migrates a project forward without leaving duplicates. Drop them once every
// install has synced once.
const DISPATCH_MARKER = "hook trigger ";
const LEGACY_MARKERS = ["WORM_RECIPE=", "/.worm/recipes/"];

/** The static settings command that routes an event back into worm. Referenced
 *  by absolute path so a PATH change can't silently disable the hooks. */
function dispatchCommand(event: HookEvent): string {
  return `node "${wormCliEntry()}" hook trigger ${event}`;
}

// --- the sandbox recipe (currently the only built-in) -----------------------

const sandboxRecipe: Recipe<SandboxRecipeConfig> = {
  name: "sandbox",
  select: (recipes) => recipes.sandbox,
  artifacts(projectName, cfg) {
    return [
      { relPath: "Dockerfile", content: renderDockerfile(cfg) },
      { relPath: "compose.yml", content: renderCompose(projectName, cfg) },
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
  // Pre-create the log dir so the dispatcher's `>> .worm/logs/…` redirects don't
  // fail (the shell opens the redirect before the command body runs).
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
    ...hookEnv(ctx.slot0Root, ctx.slot, ctx.branch),
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

// worm recognises its own hook entries by the dispatcher marker (current) or a
// legacy marker (older wiring being migrated). See the marker constants above.
function isWormManaged(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => {
      const cmd = (h as { command?: unknown })?.command;
      return (
        typeof cmd === "string" &&
        (cmd.includes(DISPATCH_MARKER) || LEGACY_MARKERS.some((m) => cmd.includes(m)))
      );
    })
  );
}

/**
 * Merge `install` into a slot's `.claude/settings.local.json` (gitignored by
 * convention, so worm never dirties a tracked repo). worm owns only the hook
 * entries it recognises (see `isWormManaged`) — so on each run it strips its
 * previous entries and re-adds `install`, leaving every other hook and key
 * intact. Pass an empty `install` to strip. Idempotent. Returns whether the
 * file changed.
 */
async function writeSlotHooks(
  slotPath: string,
  install: SettingsContribution
): Promise<boolean> {
  const settingsPath = path.join(slotPath, ".claude", "settings.local.json");
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
