import path from "node:path";
import { fs, readSymlinkTarget, readText } from "../utils/fs.js";
import { WormError } from "../utils/errors.js";
import { localConfigFile } from "./paths.js";

/**
 * Walk up from `start` looking for a worm container — a directory with `.git`
 * as a pointer file to `./.bare`. Mirrors how git itself walks up to find a
 * repo root, so worm commands work from inside any subdirectory (including
 * inside a warped worktree).
 */
export async function findContainerRoot(start: string = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await isBareCloneContainer(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new WormError(
        `Not inside a worm container (searched up from ${start}).`,
        {
          hint:
            "Set up a project with `worm clone <url>`, or cd into one of its subdirectories.",
        }
      );
    }
    current = parent;
  }
}

export function deriveProjectName(projectRoot: string): string {
  return path.basename(path.resolve(projectRoot));
}

/**
 * Resolve the canonical project name by inspecting the `.worm/config.json`
 * symlink — its target is `~/.worm/multiverses/<name>/config.json`, so the
 * parent dir's basename is the name. Use this after a project is bound;
 * `deriveProjectName` is for first-time init when no symlink exists yet.
 */
/**
 * A worm container has `.git` as a FILE pointing at `./.bare` (the bare clone
 * sibling), rather than `.git/` as a working-tree directory. This is the
 * classical multi-worktree pattern: the container itself holds no checked-out
 * files, just the bare repo and worm metadata. Worktrees are all real siblings.
 */
export async function isBareCloneContainer(projectRoot: string): Promise<boolean> {
  const gitPath = path.join(projectRoot, ".git");
  try {
    const stat = await fs.lstat(gitPath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  const content = await readText(gitPath);
  // Match `gitdir: ./.bare` or `gitdir: .bare` (with optional whitespace).
  return /^\s*gitdir:\s*\.?\/?\.bare\b/.test(content);
}

export async function readProjectName(projectRoot: string): Promise<string> {
  const configLink = localConfigFile(projectRoot);
  const target = await readSymlinkTarget(configLink);
  if (!target) {
    throw new WormError(
      "Could not determine project name — .worm/config.json is missing or not a symlink.",
      { hint: "Run `worm init` to bind this project." }
    );
  }
  return path.basename(path.dirname(target));
}

