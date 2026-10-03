import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { confirm } from "../utils/prompt.js";
import { fs, pathExists } from "../utils/fs.js";
import { gitToplevel, readProjectName } from "../core/project.js";
import { listProjectWorktrees } from "../core/worktrees.js";
import { pruneWorktrees, worktreeRemove } from "../core/git.js";
import { globalProjectDir, localRoot } from "../core/paths.js";
import { readManifest, stripWorktreeLinks } from "../core/links.js";
import { stripRecipeWiring } from "../core/recipes.js";

export interface DestroyOptions {
  force?: boolean;
}

export async function runDestroy(options: DestroyOptions = {}): Promise<void> {
  const root = await gitToplevel(process.cwd());
  if (!root) {
    throw new WormError("Not inside a git repository.", {
      hint: "Run `worm destroy` from inside a worm-bound project.",
    });
  }

  let projectName: string;
  try {
    projectName = await readProjectName(root);
  } catch {
    throw new WormError("This directory is not a worm-bound project.", {
      hint: "Nothing to destroy. If you have leftover .worm/ state, remove it manually.",
    });
  }

  const siblings = (await listProjectWorktrees(root, projectName)).filter((w) => !w.isMain);
  const globalProfile = globalProjectDir(projectName);

  logger.info(`💥 About to destroy the ${logger.bold(projectName)} project:`);
  if (siblings.length > 0) {
    logger.raw(`  • Remove ${siblings.length} linked worktree${siblings.length === 1 ? "" : "s"}:`);
    for (const s of siblings) {
      logger.raw(`      - ${s.name}: ${s.branch ?? "(detached)"} at ${logger.dim(s.path)}`);
    }
  }
  logger.raw(`  • Remove ${logger.dim(localRoot(root))}`);
  logger.raw(`  • Remove ${logger.dim(globalProfile)}`);
  logger.raw(`  • The main worktree (${logger.dim(root)}) is left untouched.`);
  logger.raw("");

  if (!options.force) {
    if (!process.stdin.isTTY) {
      throw new WormError("Refusing to destroy in a non-interactive shell.", {
        hint: "Re-run with --force to skip the confirmation prompt.",
      });
    }
    const ok = await confirm("Proceed?");
    if (!ok) {
      logger.info("Aborted.");
      return;
    }
  }

  const manifest = await readManifest(projectName);

  // 1. Remove linked worktrees (force so uncommitted changes don't block).
  for (const wt of siblings) {
    await stripWorktreeLinks(wt.path, manifest);
    await worktreeRemove(root, wt.path, { force: true });
  }
  await pruneWorktrees(root);

  // 2. Strip the main worktree's injected tunnels + recipe hooks (never remove it).
  await stripWorktreeLinks(root, manifest);
  await stripRecipeWiring(root);

  // 3. Remove local .worm/ state.
  await fs.rm(localRoot(root), { recursive: true, force: true });
  logger.step(`🧹 removed ${logger.dim(localRoot(root))}`);

  // 4. Remove the global profile.
  if (await pathExists(globalProfile)) {
    await fs.rm(globalProfile, { recursive: true, force: true });
    logger.step(`🧹 removed ${logger.dim(globalProfile)}`);
  }

  logger.success(`💥 The ${projectName} project is no more.`);
}
