import { runShell } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
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
 */
export function hookEnv(
  slot0Root: string,
  slot: UniverseSlot,
  branch: string
): NodeJS.ProcessEnv {
  return {
    WORM_PROJECT_ROOT: slot0Root,
    WORM_SLOT: slot.name,
    WORM_SLOT_INDEX: String(slot.index),
    WORM_BRANCH: branch,
    WORM_WORKTREE: slot.path,
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
