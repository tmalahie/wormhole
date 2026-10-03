import { runShell } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { portOffset, stableHash } from "./env.js";
import { globalProjectDir } from "./paths.js";
import type { Worktree } from "../types.js";

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
 * Environment exposed to user hooks (on_create / on_remove / on_assign /
 * on_release) and to recipe commands. Build it here — never inline the object at
 * the call site.
 *
 * WORM_WORKTREE / WORM_WORKTREE_NAME identify the worktree ("main" for the main
 * one). WORM_SLOT / WORM_SLOT_INDEX are the runtime slot assigned to it in
 * slots.json — the same number twice, kept under both names for older scripts —
 * or empty when none is assigned (on_create never has one).
 *
 * WORM_BRANCH_HASH / WORM_PORT_OFFSET are derived from a STABLE hash of the
 * branch, for projects that prefer branch-stable values over slot numbers.
 *
 * WORM_PROFILE is the durable per-project profile dir (`~/.worm/projects/<name>/`,
 * honouring WORM_HOME).
 */
export function hookEnv(
  mainRoot: string,
  worktree: Pick<Worktree, "name" | "path" | "slot">,
  branch: string,
  projectName: string
): NodeJS.ProcessEnv {
  const slot = worktree.slot === null ? "" : String(worktree.slot);
  return {
    WORM_PROJECT_ROOT: mainRoot,
    WORM_WORKTREE: worktree.path,
    WORM_WORKTREE_NAME: worktree.name,
    WORM_SLOT: slot,
    WORM_SLOT_INDEX: slot,
    WORM_BRANCH: branch,
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
