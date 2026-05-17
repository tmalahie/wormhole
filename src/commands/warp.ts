import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { ensureDir } from "../utils/fs.js";
import { findProjectRoot } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import {
  findSlotByBranch,
  pickFreeSlot,
  scanUniverses,
} from "../core/universe.js";
import { worktreeAdd } from "../core/git.js";
import { ensureSymlink } from "../core/symlinks.js";
import { hookEnv, runHook } from "../core/hooks.js";
import { localSharedFile, slotAnchorPath } from "../core/paths.js";
import { universeLabel } from "../core/universe.js";

export interface WarpOptions {
  create?: boolean;
  skipHook?: boolean;
}

export async function runWarp(
  branch: string,
  options: WarpOptions = {}
): Promise<void> {
  if (!branch || branch.trim().length === 0) {
    throw new WormError("Branch name is required.");
  }

  const projectRoot = await findProjectRoot();
  const config = await loadLocalConfig(projectRoot);
  const slots = await scanUniverses(projectRoot, config);

  const already = findSlotByBranch(slots, branch);
  if (already) {
    throw new WormError(
      `Branch "${branch}" is already active in slot ${already.name} (${universeLabel(already)}).`,
      { hint: `Open it at ${already.srcPath}` }
    );
  }

  const target = pickFreeSlot(slots);
  if (!target) {
    throw new WormError("No free universe slot in the Multiverse.", {
      hint: "Collapse an active branch first, or raise universes_count in your config.",
    });
  }

  logger.info(
    `🚀 Warping ${logger.bold(branch)} into ${logger.bold(universeLabel(target))} (${target.name})`
  );

  await prepareAnchorDirs(projectRoot, target.name, config.anchors);

  await worktreeAdd(projectRoot, target.srcPath, branch, {
    createIfMissing: options.create,
  });
  logger.step(`🪢 worktree opened at ${logger.dim(target.srcPath)}`);

  await injectAnchorLinks(projectRoot, target.name, target.srcPath, config.anchors);
  await injectSharedLinks(projectRoot, target.srcPath, config.shared_paths);

  if (!options.skipHook && config.hooks.on_warp) {
    const result = await runHook("on_warp", config.hooks.on_warp, {
      cwd: target.srcPath,
      env: hookEnv(projectRoot, target.name, branch),
    });
    if (result.ran && result.exitCode !== 0) {
      logger.warn(
        `on_warp hook exited with code ${result.exitCode}. The worktree exists but may be unstable.`
      );
    }
  }

  logger.success(`Quantum link established — ${logger.bold(branch)} is live in ${universeLabel(target)}.`);
  logger.raw("");
  logger.raw(`  🎯 cd ${target.srcPath}`);
}

async function prepareAnchorDirs(
  projectRoot: string,
  slot: string,
  anchors: string[]
): Promise<void> {
  for (const anchor of anchors) {
    const dir = slotAnchorPath(projectRoot, slot, anchor);
    await ensureDir(dir);
  }
}

async function injectAnchorLinks(
  projectRoot: string,
  slot: string,
  srcPath: string,
  anchors: string[]
): Promise<void> {
  for (const anchor of anchors) {
    const linkPath = path.join(srcPath, anchor);
    const targetPath = slotAnchorPath(projectRoot, slot, anchor);
    await ensureSymlink(linkPath, targetPath, { relative: true, type: "dir" });
    logger.step(`⚓ anchor ${anchor} → ${logger.dim(path.relative(srcPath, targetPath))}`);
  }
}

async function injectSharedLinks(
  projectRoot: string,
  srcPath: string,
  sharedPaths: string[]
): Promise<void> {
  for (const shared of sharedPaths) {
    const linkPath = path.join(srcPath, shared);
    const sharedSource = localSharedFile(projectRoot, shared);
    await ensureSymlink(linkPath, sharedSource, { relative: true });
    logger.step(`🔗 anomaly ${shared} → ${logger.dim(path.relative(srcPath, sharedSource))}`);
  }
}
