import path from "node:path";
import { fs, pathExists, readSymlinkTarget, readText } from "../utils/fs.js";
import { run } from "../utils/exec.js";
import { WormError } from "../utils/errors.js";
import { localConfigFile, localRoot } from "./paths.js";

export function deriveProjectName(projectRoot: string): string {
  return path.basename(path.resolve(projectRoot));
}

/**
 * Absolute toplevel of the working tree containing `cwd`, or null when not in a
 * git repo. Used by `worm init` to bind the current normal clone as Slot 0
 * (before `.worm/` exists, so `findSlot0Root` can't be used yet).
 */
export async function gitToplevel(cwd: string): Promise<string | null> {
  const { stdout, exitCode } = await run(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd }
  );
  if (exitCode !== 0) return null;
  const top = stdout.trim();
  return top.length > 0 ? top : null;
}

/**
 * Absolute path to the shared git common dir (the real `.git`) for the repo
 * containing `cwd`, or null when `cwd` isn't in a git repo. From a linked
 * worktree this resolves to Slot 0's `.git`, so its parent is Slot 0.
 * `--path-format=absolute` requires git >= 2.31.
 */
export async function gitCommonDir(cwd: string): Promise<string | null> {
  const { stdout, exitCode } = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd }
  );
  if (exitCode !== 0) return null;
  const dir = stdout.trim();
  return dir.length > 0 ? dir : null;
}

/**
 * Strategy 3 root resolution: Slot 0 is the primary working tree, and `.worm/`
 * always lives there. From any slot we ask git for the common dir and take its
 * parent, then verify a `.worm/` exists. Replaces the bare-container walk.
 */
export async function findSlot0Root(
  start: string = process.cwd()
): Promise<string> {
  const commonDir = await gitCommonDir(start);
  if (!commonDir) {
    throw new WormError(
      `Not inside a git repository (searched from ${start}).`,
      { hint: "cd into a worm project, or run `worm init` to bind one." }
    );
  }
  const root = path.dirname(commonDir);
  if (!(await pathExists(localRoot(root)))) {
    throw new WormError(`Not a worm project — no .worm/ found at ${root}.`, {
      hint: "Run `worm init` to bind this repository to a wormhole profile.",
    });
  }
  return root;
}

/**
 * Legacy detector: the pre-Strategy-3 bare-clone container had `.git` as a
 * pointer FILE to `./.bare`. Retained so a future `worm migrate` can recognise
 * old projects. Strategy 3 uses normal clones (`.git` is a directory).
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
  return /^\s*gitdir:\s*\.?\/?\.bare\b/.test(content);
}

/**
 * Resolve the canonical project name by inspecting the `.worm/config.json`
 * symlink — its target is `~/.worm/projects/<name>/config.json`, so the
 * parent dir's basename is the name.
 */
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
