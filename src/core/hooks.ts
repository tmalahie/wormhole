import { runShell } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { portOffset, stableHash } from "./env.js";
import { globalProjectDir } from "./paths.js";
import type { UniverseSlot } from "../types.js";

export interface HookResult {
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HookContext {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Environment exposed to user hooks (on_create / on_remove). Build it here —
 * never inline the object at the call site. WORM_SLOT_INDEX is 0 for Slot 0.
 *
 * WORM_BRANCH_HASH / WORM_PORT_OFFSET are derived from a STABLE hash of the
 * branch (not the positional index): a given branch keeps the same offset across
 * machines and across slot reordering, so `PORT=$((8080 + WORM_PORT_OFFSET))` in
 * setup.sh is stable even with ephemeral worktrees.
 *
 * WORM_PROFILE is the durable per-project profile dir (`~/.worm/projects/<name>/`,
 * honouring WORM_HOME) — where recipe artifacts, logs, the manifest, and any
 * user-owned shared state (e.g. a project's shared-uploads dir) live. Hooks that
 * need to reach into the profile should use it rather than guessing `~/.worm`.
 */
export function hookEnv(
  slot0Root: string,
  slot: UniverseSlot,
  branch: string,
  projectName: string
): NodeJS.ProcessEnv {
  return {
    WORM_PROJECT_ROOT: slot0Root,
    WORM_SLOT: slot.name,
    WORM_SLOT_INDEX: String(slot.index),
    WORM_BRANCH: branch,
    WORM_WORKTREE: slot.path,
    WORM_BRANCH_HASH: String(stableHash(branch)),
    WORM_PORT_OFFSET: String(portOffset(branch)),
    WORM_PROFILE: globalProjectDir(projectName),
  };
}

export async function runHook(
  hookName: string,
  command: string | undefined,
  context: HookContext
): Promise<HookResult> {
  if (!command || command.trim().length === 0) {
    return { ran: false, exitCode: 0, stdout: "", stderr: "" };
  }
  logger.step(`⚡ hook ${hookName}: ${command}`);
  const result = await runShell(command, {
    cwd: context.cwd,
    env: context.env,
    inheritStdio: true,
  });
  return { ran: true, ...result };
}
