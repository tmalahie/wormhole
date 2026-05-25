import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs, isSymlink } from "../utils/fs.js";
import { findContainerRoot } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { resolveSlotRef, scanUniverses, universeLabel } from "../core/universe.js";
import { dirtyFiles, pruneWorktrees, worktreeRemove } from "../core/git.js";
import { hookEnv, runHook } from "../core/hooks.js";
import type { Config } from "../types.js";

export interface CollapseOptions {
  force?: boolean;
  skipHook?: boolean;
}

export async function runCollapse(
  ref: string,
  options: CollapseOptions = {}
): Promise<void> {
  if (!ref || ref.trim().length === 0) {
    throw new WormError("Missing branch or slot index.", {
      hint: "Usage: worm collapse <branch-or-index>",
    });
  }

  const projectRoot = await findContainerRoot();
  const config = await loadLocalConfig(projectRoot);
  const slots = await scanUniverses(projectRoot, config);

  const slot = resolveSlotRef(ref, slots, { requireActive: true });
  // The branch label we use in messages and the hook env — branchless detached
  // slots show as `(detached)` (matching what scan reports).
  const branchLabel = slot.branch ?? "(detached)";

  logger.info(
    `💫 Collapsing ${logger.bold(branchLabel)} from ${logger.bold(universeLabel(slot))} (${slot.name})`
  );

  // Filter out our own injected symlinks — they appear as untracked but
  // they're worm's scaffolding, not the user's work.
  const injected = new Set([...config.anchors, ...config.shared_paths]);
  const dirty = (await dirtyFiles(slot.srcPath)).filter((line) => {
    const filePath = line.length > 3 ? line.slice(3) : line;
    return !injected.has(filePath);
  });
  if (dirty.length > 0) {
    if (!options.force) {
      const preview = dirty.slice(0, 5).map((line) => `    ${line}`).join("\n");
      const tail = dirty.length > 5 ? `\n    … and ${dirty.length - 5} more` : "";
      throw new WormError(
        `${universeLabel(slot)} (${slot.name}) has uncommitted changes in ${slot.srcPath}:\n${preview}${tail}`,
        {
          hint:
            "Commit or push them from the worktree, or pass --force to discard them (changes will be lost).",
        }
      );
    }
    logger.warn(
      `Discarding ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} in ${slot.srcPath} (--force).`
    );
  }

  if (!options.skipHook && config.hooks.on_collapse) {
    const result = await runHook("on_collapse", config.hooks.on_collapse, {
      cwd: slot.srcPath,
      env: hookEnv(projectRoot, slot.name, branchLabel),
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
