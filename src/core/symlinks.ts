import path from "node:path";
import { WormError } from "../utils/errors.js";
import { ensureDir, fs, isSymlink, pathExists, readSymlinkTarget } from "../utils/fs.js";

export interface SymlinkResult {
  created: boolean;
  alreadyCorrect: boolean;
  path: string;
  target: string;
}

/**
 * Create a symlink at `linkPath` pointing to `targetPath`.
 * The on-disk target is stored relative to the link's directory.
 * Idempotent: if the link already points to the right place, nothing happens.
 */
export async function ensureSymlink(
  linkPath: string,
  targetPath: string,
  options: { relative?: boolean; type?: "file" | "dir" } = {}
): Promise<SymlinkResult> {
  const absoluteTarget = path.resolve(targetPath);
  const linkDir = path.dirname(path.resolve(linkPath));
  const storedTarget = options.relative === false
    ? absoluteTarget
    : path.relative(linkDir, absoluteTarget);

  await ensureDir(linkDir);

  if (await pathExists(linkPath)) {
    if (!(await isSymlink(linkPath))) {
      throw new WormError(
        `Cannot create symlink at ${linkPath}: a real file/directory already exists there.`,
        { hint: "Move or delete the existing entry, then re-run the command." }
      );
    }
    const current = await readSymlinkTarget(linkPath);
    if (current === storedTarget) {
      return { created: false, alreadyCorrect: true, path: linkPath, target: storedTarget };
    }
    await fs.unlink(linkPath);
  }

  const symlinkType =
    options.type ?? (await guessSymlinkType(absoluteTarget));
  await fs.symlink(storedTarget, linkPath, symlinkType);
  return { created: true, alreadyCorrect: false, path: linkPath, target: storedTarget };
}

async function guessSymlinkType(absoluteTarget: string): Promise<"file" | "dir"> {
  try {
    const stat = await fs.stat(absoluteTarget);
    return stat.isDirectory() ? "dir" : "file";
  } catch {
    return "file";
  }
}
