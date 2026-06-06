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
import { globalProjectFile, localLogsDir, localRecipeDir, packagedRecipeScript } from "./paths.js";
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
 * compose because the settings merge namespaces each entry by a worm-owned
 * marker (see RECIPE_HOOK_MARKER), so re-running strips and re-adds only worm's
 * entries and never touches a user's own hooks.
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

// --- hook-command markers ----------------------------------------------------

/**
 * Marker every worm-generated hook command carries (as an env assignment) so
 * the engine can find and replace ONLY its own entries on re-wiring, leaving a
 * user's own hooks untouched. The command now points at packaged code (not a
 * per-project `.worm/recipes/` path), so the path can no longer serve as the
 * marker — this explicit env var does.
 */
const RECIPE_HOOK_MARKER = "WORM_RECIPE=";

/**
 * Transitional marker: the `.worm/recipes/` path that pre-live-once versions
 * embedded in their hook commands. Recognising it lets a single `worm sync`
 * migrate an existing project off the old wiring instead of leaving a duplicate
 * un-marked entry behind. Safe to drop once every install has synced once.
 */
const LEGACY_HOOK_MARKER = "/.worm/recipes/";

/**
 * Env prefix stamped on a recipe's hook command: the marker (identifying the
 * recipe) plus, for the packaged node scripts, the log dir they append to.
 */
function recipeEnv(recipe: string, logDir?: string): string {
  const parts = [`WORM_RECIPE="${recipe}"`];
  if (logDir) parts.push(`WORM_LOG_DIR="${logDir}"`);
  return parts.join(" ");
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
  wireSlot({ slot0Root, projectName, slot }, cfg) {
    const dir = localRecipeDir(slot0Root, "sandbox");
    const compose = path.join(dir, "compose.yml");
    const policy = path.join(dir, "sandbox-policy.json");
    // Code lives ONCE in the package; the per-project bits (container, compose,
    // policy) are passed as args, so there's nothing to copy or keep in sync.
    const script = packagedRecipeScript("sandbox", "redirect-to-sandbox.js");
    const container = `${projectName}-${slot.name}-sandbox`;
    const project = `${projectName}-${slot.name}`;
    const logDir = localLogsDir(slot0Root);
    // The interceptor's stdout IS the permission decision, so it logs its own
    // decisions to a file (via $WORM_LOG_DIR) rather than being output-redirected.
    const log = path.join(logDir, `${container}.log`);
    const intercept = `${recipeEnv("sandbox", logDir)} node "${script}" "${container}" "${compose}" "${policy}"`;
    const block: SettingsContribution = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: intercept }] }],
    };
    if (cfg.autostart) {
      const up = `${recipeEnv("sandbox")} SANDBOX_DIR="${slot.path}" SANDBOX_CONTAINER="${container}" docker compose -p "${project}" -f "${compose}" up -d`;
      block.SessionStart = [{ hooks: [{ type: "command", command: logged(up, log, "up") }] }];
    }
    if (cfg.autostop) {
      const down = `${recipeEnv("sandbox")} docker compose -p "${project}" -f "${compose}" down`;
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
  // No artifacts: the sync script is worm-owned code that lives ONCE in the
  // package (parameterized at run time), never copied into a project.
  wireSlot({ slot0Root, projectName }) {
    const script = packagedRecipeScript("syncPermissions", "sync-claude-settings.js");
    // The canonical union store lives in the PERSISTENT global profile (in
    // ~/.worm — committed, shared across slots, surviving re-clones), NOT the
    // ephemeral local .worm/recipes/. It's also where a user's accumulated
    // allowlist already lives, so existing permissions are pulled in on first run.
    const canonical = globalProjectFile(projectName, path.join(".claude", "settings.local.json"));
    const command = `${recipeEnv("syncPermissions", localLogsDir(slot0Root))} node "${script}" "${canonical}"`;
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
  return writeSlotHooks(slot.path, install);
}

/** Remove all worm-managed recipe hooks from a slot (used on `destroy`). */
export async function stripRecipeWiring(slotPath: string): Promise<boolean> {
  return writeSlotHooks(slotPath, {});
}

// worm recognises its own hook entries two ways: the canonical WORM_RECIPE= env
// marker stamped on every command it writes now, and — transitionally — the
// legacy `.worm/recipes/` path embedded by pre-live-once versions.
function isWormManaged(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => {
      const cmd = (h as { command?: unknown })?.command;
      return (
        typeof cmd === "string" &&
        (cmd.includes(RECIPE_HOOK_MARKER) || cmd.includes(LEGACY_HOOK_MARKER))
      );
    })
  );
}

/**
 * Merge `install` into a slot's `.claude/settings.local.json` (gitignored by
 * convention, so worm never dirties a tracked repo). worm owns only the hook
 * entries it recognises — their commands carry the `WORM_RECIPE=` marker — so on
 * each run it strips its previous entries and re-adds `install`, leaving every
 * other hook and key (and other recipes' entries) intact. Pass an empty
 * `install` to strip. Idempotent. Returns whether the file changed.
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
