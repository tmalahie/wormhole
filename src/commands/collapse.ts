import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs, isSymlink } from "../utils/fs.js";
import { findProjectRoot } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { findSlotByBranch, scanUniverses, universeLabel } from "../core/universe.js";
import { pruneWorktrees, worktreeRemove } from "../core/git.js";
import { hookEnv, runHook } from "../core/hooks.js";
import type { Config } from "../types.js";

export interface CollapseOptions {
  force?: boolean;
  skipHook?: boolean;
}

export async function runCollapse(
  branch: string,
  options: CollapseOptions = {}
): Promise<void> {
  if (!branch || branch.trim().length === 0) {
    throw new WormError("Branch name is required.");
  }

  const projectRoot = await findProjectRoot();
  const config = await loadLocalConfig(projectRoot);
  const slots = await scanUniverses(projectRoot, config);

  const slot = findSlotByBranch(slots, branch);
  if (!slot) {
    throw new WormError(
      `Branch "${branch}" is not currently warped into any universe slot.`,
      { hint: "Run `worm status` to see active branches." }
    );
  }

  logger.info(
    `💫 Collapsing ${logger.bold(branch)} from ${logger.bold(universeLabel(slot))} (${slot.name})`
  );

  if (!options.skipHook && config.hooks.on_collapse) {
    const result = await runHook("on_collapse", config.hooks.on_collapse, {
      cwd: slot.srcPath,
      env: hookEnv(projectRoot, slot.name, branch),
    });
    if (result.ran && result.exitCode !== 0 && !options.force) {
      throw new WormError(
        `on_collapse hook exited with code ${result.exitCode}. Aborting to avoid losing state.`,
        { hint: "Pass --force to collapse anyway, or fix the hook output above." }
      );
    }
  }

  await removeInjectedSymlinks(slot.srcPath, config);
  logger.step("🧹 swept wormhole symlinks");

  await worktreeRemove(projectRoot, slot.srcPath, { force: options.force });
  logger.step(`🪢 worktree dispersed at ${logger.dim(slot.srcPath)}`);

  await pruneWorktrees(projectRoot);

  logger.success(
    `${universeLabel(slot)} is stable. Anchors (node_modules, .venv) kept warm for the next warp.`
  );
}

async function removeInjectedSymlinks(srcPath: string, config: Config): Promise<void> {
  const injected = [...config.anchors, ...config.shared_paths];
  for (const entry of injected) {
    const target = path.join(srcPath, entry);
    if (await isSymlink(target)) {
      await fs.unlink(target);
    }
  }
}
