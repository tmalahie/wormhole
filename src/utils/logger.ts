import pc from "picocolors";

// When stdout carries a machine-readable answer (`worm hook worktree-create`
// prints only the path; `--json` prints only JSON), every human-facing line goes
// to stderr instead. Child hooks follow the same switch (see utils/exec.ts).
let stdoutReserved = false;

/** Route all human-facing output to stderr from now on (for the life of the process). */
export function reserveStdout(): void {
  stdoutReserved = true;
}

export function isStdoutReserved(): boolean {
  return stdoutReserved;
}

function out(message: string): void {
  if (stdoutReserved) console.error(message);
  else console.log(message);
}

export const logger = {
  info(message: string): void {
    out(message);
  },
  step(message: string): void {
    out(`  ${pc.dim("·")} ${pc.dim(message)}`);
  },
  success(message: string): void {
    out(`✨ ${pc.green(message)}`);
  },
  warn(message: string): void {
    console.warn(`⚠️  ${pc.yellow(message)}`);
  },
  error(message: string): void {
    console.error(`💥 ${pc.red(message)}`);
  },
  hint(message: string): void {
    console.error(`   💡 ${pc.dim(message)}`);
  },
  raw(message: string): void {
    out(message);
  },
  blank(): void {
    out("");
  },
  dim(message: string): string {
    return pc.dim(message);
  },
  bold(message: string): string {
    return pc.bold(message);
  },
  green(message: string): string {
    return pc.green(message);
  },
  yellow(message: string): string {
    return pc.yellow(message);
  },
  red(message: string): string {
    return pc.red(message);
  },
  cyan(message: string): string {
    return pc.cyan(message);
  },
  white(message: string): string {
    return pc.white(message);
  },
};
