import { execa, ExecaError, type Options } from "execa";
import { WormError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritStdio?: boolean;
  shell?: boolean | string;
  /** Written to the child's stdin (used by the hook dispatcher's filter run). */
  input?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const execOptions: Options = {
    cwd: options.cwd,
    env: options.env,
    stdio: options.inheritStdio ? "inherit" : "pipe",
    reject: false,
  };
  const result = await execa(command, args, execOptions);
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.exitCode ?? 0,
  };
}

export async function runOrThrow(
  command: string,
  args: string[],
  options: RunOptions = {},
  errorMessage?: string
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    const base = errorMessage ?? `Command failed: ${command} ${args.join(" ")}`;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new WormError(detail ? `${base}\n${detail}` : base);
  }
  return result;
}

export async function runShell(
  command: string,
  options: RunOptions = {}
): Promise<RunResult> {
  try {
    const result = await execa(command, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? true,
      stdio: options.inheritStdio ? "inherit" : "pipe",
      input: options.input,
      reject: false,
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode ?? 0,
    };
  } catch (err) {
    if (err instanceof ExecaError) {
      return {
        stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr: typeof err.stderr === "string" ? err.stderr : "",
        exitCode: err.exitCode ?? 1,
      };
    }
    throw err;
  }
}
