import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs, isSymlink, pathExists } from "../utils/fs.js";
import { findSlot0Root, gitToplevel, readProjectName } from "../core/project.js";
import { readDetached, readManifest, writeDetached, writeManifest } from "../core/links.js";

/**
 * `worm detach <file>` — sever a shared-path tunnel in the CURRENT worktree only,
 * replacing the symlink with an independent real copy. The other slots keep the
 * shared link, and `worm sync` won't restore this one (the reconcile deref-guard
 * leaves a real file alone). The inverse of adoption: "I want this file local to
 * this worktree" — e.g. a per-worktree `.env` tweak that mustn't leak elsewhere.
 */
export async function runDetach(file?: string): Promise<void> {
  if (!file || file.trim().length === 0) {
    throw new WormError("Missing file to detach.", {
      hint: "Usage: worm detach <file> (a shared_paths tunnel, e.g. .env)",
    });
  }

  const top = await gitToplevel(process.cwd());
  if (!top) {
    throw new WormError("Not inside a git worktree.", {
      hint: "Run `worm detach` from inside the worktree whose file you want to localise.",
    });
  }
  const worktreeRoot = await fs.realpath(top);
  const slot0Root = await findSlot0Root(worktreeRoot);
  const projectName = await readProjectName(slot0Root);

  const manifest = await readManifest(projectName);
  const key = worktreeRoot;
  const tails = manifest[key] ?? [];
  const linkPath = path.join(worktreeRoot, file);

  if (!tails.includes(file)) {
    throw new WormError(`"${file}" isn't a worm-managed link in this worktree.`, {
      hint: "Only a shared_paths tunnel can be detached. Check the name, or run `worm sync` first.",
    });
  }
  if (!(await isSymlink(linkPath))) {
    const what = (await pathExists(linkPath)) ? "already a real file" : "missing";
    throw new WormError(`"${file}" is ${what} here — nothing to detach.`, {
      hint: "Detach only converts a shared symlink into a local copy.",
    });
  }

  // Resolve the real source, then replace the symlink with an independent copy.
  const realSource = await fs.realpath(linkPath);
  await fs.unlink(linkPath);
  await fs.cp(realSource, linkPath, { recursive: true });

  // Drop it from this slot's managed set — it's a local file now, not a tunnel.
  manifest[key] = tails.filter((t) => t !== file);
  await writeManifest(projectName, manifest);

  // Record the detach so adoption/reconcile leave this slot-local file alone
  // (delete the file and `worm sync` to re-attach).
  const detached = await readDetached(projectName);
  const list = detached[key] ?? [];
  if (!list.includes(file)) list.push(file);
  detached[key] = list;
  await writeDetached(projectName, detached);

  logger.success(
    `🌀 detached ${logger.bold(file)} in ${logger.dim(worktreeRoot)} — now a local copy.`
  );
  logger.hint("Other slots keep the shared link; `worm sync` won't restore this one.");
}
