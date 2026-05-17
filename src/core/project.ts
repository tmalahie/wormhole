import path from "node:path";
import { pathExists, readText, fs } from "../utils/fs.js";
import { WormError } from "../utils/errors.js";
import { LOCAL_ROOT_NAME } from "./paths.js";

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

const GITIGNORE_BLOCK_MARKER = "# wormhole";

export async function ensureGitignoreEntry(
  projectRoot: string,
  entry: string = `${LOCAL_ROOT_NAME}/`
): Promise<{ updated: boolean; created: boolean }> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existed = await pathExists(gitignorePath);
  const current = existed ? await readText(gitignorePath) : "";
  const lines = current.split(/\r?\n/);
  const hasEntry = lines.some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""));
  if (hasEntry) return { updated: false, created: !existed };
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const block = `${prefix}\n${GITIGNORE_BLOCK_MARKER}\n${entry}\n`;
  await fs.writeFile(gitignorePath, current + block, "utf8");
  return { updated: true, created: !existed };
}
