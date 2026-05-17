import path from "node:path";
import { pathExists } from "../utils/fs.js";
import { WormError } from "../utils/errors.js";

export async function findProjectRoot(start: string = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new WormError(
        `Not inside a git repository (searched from ${start}).`,
        { hint: "Run `git init` first, or cd into a project that has a .git directory." }
      );
    }
    current = parent;
  }
}

export function deriveProjectName(projectRoot: string): string {
  return path.basename(path.resolve(projectRoot));
}
