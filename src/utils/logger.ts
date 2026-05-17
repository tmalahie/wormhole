import pc from "picocolors";

export const logger = {
  info(message: string): void {
    console.log(message);
  },
  step(message: string): void {
    console.log(`  ${pc.dim("·")} ${pc.dim(message)}`);
  },
  success(message: string): void {
    console.log(`✨ ${pc.green(message)}`);
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
    console.log(message);
  },
  blank(): void {
    console.log("");
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
};
