import path from "node:path";
import { findMainRoot, gitToplevel, readProjectName } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { WormError } from "../utils/errors.js";
import { reserveStdout } from "../utils/logger.js";
import { branchExists, remoteBranchExists } from "../core/git.js";
import { pathExists } from "../utils/fs.js";
import {
  createWorktree,
  listProjectWorktrees,
  openProject,
  removeWorktree,
  resolveWorktreeRef,
  worktreeNameForBranch,
} from "../core/worktrees.js";
import { currentBranch } from "../core/git.js";
import { localLogsDir } from "../core/paths.js";
import { readSlots, slotOf } from "../core/slots.js";
import { ensureDir, fs } from "../utils/fs.js";
import {
  HOOK_EVENTS,
  runGlobalRecipeHooks,
  runRecipeContext,
  runRecipeFilters,
  runRecipeHooks,
  type DispatchContext,
  type HookEvent,
} from "../core/recipes.js";
import { loadGlobalConfig } from "../core/global-config.js";
import type { Worktree } from "../types.js";

/**
 * `worm hook trigger <event>` — the inverted-dispatch entry point. A slot's
 * settings.local.json holds ONE static entry per event that calls this; here we
 * resolve the live slot, read the project's recipes, and run each enabled
 * recipe's commands for the event (env injected, logging owned by the engine).
 *
 * Contract: this runs on the agent's hot path, so it must NEVER throw, and for a
 * FILTER event it must write ONLY the permission decision to stdout (its stdout
 * IS what the agent reads). Failures are recorded to `.worm/logs/dispatch.log`
 * and fail OPEN — a worm bug must not block every command. (The interceptor's
 * own decision logic still denies on malformed input.)
 */
export async function runHookTrigger(
  rawEvent: string,
  options: { global?: boolean } = {}
): Promise<void> {
  const meta = HOOK_EVENTS[rawEvent as HookEvent];
  if (!meta) return; // unknown event → no-op
  const event = rawEvent as HookEvent;

  // Global dispatch: machine-wide recipes (autosync, notify, syncGlobalPermissions)
  // from ~/.worm/config.json, with NO project resolution — this hook fires from
  // anywhere, even non-worm dirs. Read stdin first so the payload reaches recipes
  // that need it (notify); read it even for run events (the project path doesn't).
  if (options.global) {
    const input = await readStdin();
    try {
      const recipes = (await loadGlobalConfig()).recipes ?? {};
      await runGlobalRecipeHooks(recipes, event, input);
    } catch (err) {
      await recordDispatchError(err);
    }
    return;
  }

  if (meta.kind !== "run") {
    // stdin-driven events (filter + context). Read the input first so a
    // resolution failure can't lose it; then forward the dispatcher's stdout
    // verbatim (a permission decision, or the prompt-context envelope).
    const input = await readStdin();
    try {
      const ctx = await resolveContext(false);
      const { recipes } = await loadLocalConfig(ctx.mainRoot);
      const out =
        meta.kind === "filter"
          ? await runRecipeFilters(ctx, recipes, event, input)
          : await runRecipeContext(ctx, recipes, event, input);
      if (out) process.stdout.write(out);
    } catch (err) {
      await recordDispatchError(err);
    }
    return;
  }

  try {
    const ctx = await resolveContext(true);
    const { recipes } = await loadLocalConfig(ctx.mainRoot);
    await runRecipeHooks(ctx, recipes, event);
  } catch (err) {
    await recordDispatchError(err); // never block a session
  }
}

async function resolveContext(withBranch: boolean): Promise<DispatchContext> {
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const mainRoot = await findMainRoot(start);
  const projectName = await readProjectName(mainRoot);
  const here = path.resolve((await gitToplevel(start)) ?? start);
  // Cheap identification (no `git worktree list`) — this runs on the hot path.
  const isMain = here === path.resolve(mainRoot);
  const worktree: Worktree = {
    name: isMain ? "main" : path.basename(here),
    path: here,
    isMain,
    slot: slotOf(await readSlots(projectName), here),
  };
  const branch = withBranch ? ((await currentBranch(here)) ?? "") : "";
  return { mainRoot, projectName, worktree, branch };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function recordDispatchError(err: unknown): Promise<void> {
  try {
    const mainRoot = await findMainRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const logDir = localLogsDir(mainRoot);
    await ensureDir(logDir);
    await fs.appendFile(
      path.join(logDir, "dispatch.log"),
      `[${new Date().toISOString()}] hook dispatch error: ${String(err)}\n`
    );
  } catch {
    if (process.env.WORM_DEBUG === "1") console.error("worm hook dispatch error:", err);
  }
}

// --- Claude Code's WorktreeCreate / WorktreeRemove hooks ---------------------
// Installed by `worm sync` into the profile's .claude/settings.json. Once a
// WorktreeCreate hook exists Claude never runs `git worktree add` itself (CLI and
// Desktop, `EnterWorktree`, `--worktree`): it runs this and uses the path printed
// on stdout. Likewise WorktreeRemove: Claude removes nothing itself.

interface WorktreeHookPayload {
  hook_event_name?: string;
  name?: string;
  cwd?: string;
  worktree_path?: string;
}

function parsePayload(raw: string): WorktreeHookPayload {
  try {
    return JSON.parse(raw) as WorktreeHookPayload;
  } catch {
    throw new WormError("Expected Claude's hook JSON on stdin.");
  }
}

/**
 * `worm hook worktree-create` — stdin `{ name, cwd, … }`; stdout: the worktree's
 * absolute path, nothing else (all logs and the setup script's output go to
 * stderr). Idempotent: an existing worktree of that name is returned as is. The
 * branch is `name` when such a branch exists, else `worktree-<name>` (Claude's
 * own convention); a branch already checked out in a linked worktree returns
 * that worktree.
 */
export async function runHookWorktreeCreate(): Promise<void> {
  reserveStdout();
  const payload = parsePayload(await readStdin());
  if (!payload.name) throw new WormError("WorktreeCreate payload has no name.");
  const project = await openProject(payload.cwd || process.cwd());
  const name = worktreeNameForBranch(payload.name);
  const worktrees = await listProjectWorktrees(project.mainRoot, project.projectName);

  const sameName = worktrees.find((w) => !w.isMain && w.name === name);
  if (sameName) {
    process.stdout.write(sameName.path + "\n");
    return;
  }
  const isBranch =
    (await branchExists(project.mainRoot, payload.name)) ||
    (await remoteBranchExists(project.mainRoot, payload.name)) !== null;
  const branch = isBranch ? payload.name : `worktree-${name}`;
  const holder = worktrees.find((w) => !w.isMain && w.branch === branch);
  if (holder) {
    process.stdout.write(holder.path + "\n");
    return;
  }
  const wt = await createWorktree(project, { branch, name });
  process.stdout.write(wt.path + "\n");
}

/**
 * `worm hook worktree-remove` — stdin `{ worktree_path, … }`. Removes the worktree
 * the way `worm worktree rm --force` does (Claude asked the user about discarding
 * changes before firing this). Never removes the main worktree; never fails the
 * session for a worktree that is already gone.
 */
export async function runHookWorktreeRemove(): Promise<void> {
  reserveStdout();
  const payload = parsePayload(await readStdin());
  const target = payload.worktree_path || payload.cwd;
  if (!target || !(await pathExists(target))) return;
  const project = await openProject(target);
  const wt = resolveWorktreeRef(path.resolve(target), await listProjectWorktrees(project.mainRoot, project.projectName));
  if (wt.isMain) {
    process.stderr.write("worm: refusing to remove the main worktree.\n");
    return;
  }
  await removeWorktree(project, wt, { force: true });
}
