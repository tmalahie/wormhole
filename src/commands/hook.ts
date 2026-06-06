import path from "node:path";
import { findSlot0Root, gitToplevel, readProjectName } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { currentBranch } from "../core/git.js";
import { localLogsDir, SLOT_DIR_INFIX } from "../core/paths.js";
import { ensureDir, fs } from "../utils/fs.js";
import {
  HOOK_EVENTS,
  runRecipeFilters,
  runRecipeHooks,
  type DispatchContext,
  type HookEvent,
} from "../core/recipes.js";
import type { UniverseSlot } from "../types.js";

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
export async function runHookTrigger(rawEvent: string): Promise<void> {
  const meta = HOOK_EVENTS[rawEvent as HookEvent];
  if (!meta) return; // unknown event → no-op
  const event = rawEvent as HookEvent;

  if (meta.filter) {
    // Read the tool input first so a resolution failure can't lose it.
    const input = await readStdin();
    try {
      const ctx = await resolveContext(false);
      const { recipes } = await loadLocalConfig(ctx.slot0Root);
      const decision = await runRecipeFilters(ctx, recipes, event, input);
      if (decision) process.stdout.write(decision);
    } catch (err) {
      await recordDispatchError(err);
    }
    return;
  }

  try {
    const ctx = await resolveContext(true);
    const { recipes } = await loadLocalConfig(ctx.slot0Root);
    await runRecipeHooks(ctx, recipes, event);
  } catch (err) {
    await recordDispatchError(err); // never block a session
  }
}

async function resolveContext(withBranch: boolean): Promise<DispatchContext> {
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const slot0Root = await findSlot0Root(start);
  const projectName = await readProjectName(slot0Root);
  const slot = deriveSlot(slot0Root, (await gitToplevel(start)) ?? start);
  const branch = withBranch ? (await currentBranch(slot.path)) ?? "" : "";
  return { slot0Root, projectName, slot, branch };
}

/**
 * Which slot is `worktreeRoot`? Slot 0 if it IS slot0Root, else parse the
 * `<base><INFIX><N>` sibling suffix. Cheap (no `git worktree list`) since this
 * runs on the hot path. An unrecognised worktree falls back to Slot 0.
 */
function deriveSlot(slot0Root: string, worktreeRoot: string): UniverseSlot {
  const root = path.resolve(slot0Root);
  const here = path.resolve(worktreeRoot);
  const slot0: UniverseSlot = {
    index: 0,
    name: "main",
    isPrimary: true,
    path: root,
    status: "READY",
  };
  if (here === root) return slot0;
  const prefix = `${path.basename(root)}${SLOT_DIR_INFIX}`;
  const name = path.basename(here);
  if (path.dirname(here) === path.dirname(root) && name.startsWith(prefix)) {
    const rest = name.slice(prefix.length);
    if (/^\d+$/.test(rest)) {
      return {
        index: Number.parseInt(rest, 10),
        name: rest,
        isPrimary: false,
        path: here,
        status: "READY",
      };
    }
  }
  return slot0;
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
    const slot0Root = await findSlot0Root(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const logDir = localLogsDir(slot0Root);
    await ensureDir(logDir);
    await fs.appendFile(
      path.join(logDir, "dispatch.log"),
      `[${new Date().toISOString()}] hook dispatch error: ${String(err)}\n`
    );
  } catch {
    if (process.env.WORM_DEBUG === "1") console.error("worm hook dispatch error:", err);
  }
}
