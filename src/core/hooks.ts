import { runShell } from "../utils/exec.js";
import { logger } from "../utils/logger.js";

export interface HookResult {
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runHook(
  hookName: string,
  command: string | undefined,
  cwd: string
): Promise<HookResult> {
  if (!command || command.trim().length === 0) {
    return { ran: false, exitCode: 0, stdout: "", stderr: "" };
  }
  logger.step(`hook ${hookName}: ${command}`);
  const result = await runShell(command, { cwd, inheritStdio: true });
  return { ran: true, ...result };
}
