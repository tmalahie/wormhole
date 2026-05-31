import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { findSlot0Root, readProjectName } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import {
  findSlotByBranch,
  nextFreeIndex,
  resolveSlotRef,
  scanUniverses,
  universeLabel,
} from "../core/universe.js";
import {
  dirtyFiles,
  pruneWorktrees,
  worktreeAdd,
  worktreeRemove,
} from "../core/git.js";
import { siblingWorktreeDir } from "../core/paths.js";
import { applyRecipeWiring, materializeRecipes } from "../core/recipes.js";
import { hookEnv, runHook } from "../core/hooks.js";
import {
  readManifest,
  reconcileSlotLinks,
  stripSlotLinks,
  writeManifest,
} from "../core/links.js";
import type { UniverseSlot } from "../types.js";

export interface UniverseAddOptions {
  create?: boolean;
  skipHook?: boolean;
}

export interface UniverseRemoveOptions {
  force?: boolean;
  skipHook?: boolean;
}

export async function runUniverseAdd(
  branch: string,
  options: UniverseAddOptions = {}
): Promise<void> {
  if (!branch || branch.trim().length === 0) {
    throw new WormError("Branch name is required.", {
      hint: "Usage: worm universe add <branch>",
    });
  }

  const root = await findSlot0Root();
  const config = await loadLocalConfig(root);
  const slots = await scanUniverses(root);

  const already = findSlotByBranch(slots, branch);
  if (already) {
    throw new WormError(
      `Branch "${branch}" is already checked out in ${universeLabel(already)}.`,
      { hint: `Open it at ${already.path}` }
    );
  }

  const index = nextFreeIndex(slots);
  const target = siblingWorktreeDir(root, index);

  logger.info(
    `🌌 Adding ${logger.bold(`Universe ${index}`)} on ${logger.bold(branch)} (${logger.dim(target)})`
  );

  await worktreeAdd(root, target, branch, { createIfMissing: options.create });
  logger.step(`🪢 worktree opened at ${logger.dim(target)}`);

  const manifest = await readManifest(root);
  await reconcileSlotLinks(root, target, config.shared_paths, manifest);
  await writeManifest(root, manifest);

  if (!options.skipHook && config.hooks.on_create) {
    const slot: UniverseSlot = {
      index,
      name: String(index),
      isPrimary: false,
      path: target,
      status: "READY",
      branch,
    };
    const result = await runHook("on_create", config.hooks.on_create, {
      cwd: target,
      env: hookEnv(root, slot, branch),
    });
    if (result.ran && result.exitCode !== 0) {
      logger.warn(
        `on_create hook exited with code ${result.exitCode}. The worktree exists but may not be fully warmed.`
      );
    }
  }

  // Provision recipe artifacts (idempotent) and wire this slot (no-op when none enabled).
  const projectName = await readProjectName(root);
  await materializeRecipes(root, projectName, config.recipes);
  if (await applyRecipeWiring(root, projectName, { name: String(index), path: target }, config.recipes)) {
    logger.step("⚡ wired recipe hooks");
  }

  logger.success(`Universe ${index} is live on ${logger.bold(branch)}.`);
  logger.raw("");
  logger.raw(`  🎯 cd ${target}`);
}

export async function runUniverseRemove(
  ref: string,
  options: UniverseRemoveOptions = {}
): Promise<void> {
  if (!ref || ref.trim().length === 0) {
    throw new WormError("Missing slot index or branch.", {
      hint: "Usage: worm universe rm <index-or-branch>",
    });
  }

  const root = await findSlot0Root();
  const config = await loadLocalConfig(root);
  const slots = await scanUniverses(root);
  const slot = resolveSlotRef(ref, slots);

  if (slot.isPrimary) {
    throw new WormError("Refusing to remove Slot 0 — that's your main checkout.", {
      hint: "Slot 0 is permanent. Remove a sibling universe (index >= 1).",
    });
  }

  const dirty = await dirtyFiles(slot.path);
  if (dirty.length > 0 && !options.force) {
    const preview = dirty.slice(0, 5).map((line) => `    ${line}`).join("\n");
    const tail = dirty.length > 5 ? `\n    … and ${dirty.length - 5} more` : "";
    throw new WormError(
      `${universeLabel(slot)} has uncommitted changes in ${slot.path}:\n${preview}${tail}`,
      {
        hint: "Commit or push them from the worktree, or pass --force to discard them (changes will be lost).",
      }
    );
  }
  if (dirty.length > 0) {
    logger.warn(
      `Discarding ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} in ${slot.path} (--force).`
    );
  }

  logger.info(`💫 Collapsing ${logger.bold(universeLabel(slot))}`);

  if (!options.skipHook && config.hooks.on_remove) {
    const result = await runHook("on_remove", config.hooks.on_remove, {
      cwd: slot.path,
      env: hookEnv(root, slot, slot.branch ?? ""),
    });
    if (result.ran && result.exitCode !== 0 && !options.force) {
      throw new WormError(
        `on_remove hook exited with code ${result.exitCode}. Aborting to avoid losing state.`,
        { hint: "Pass --force to remove anyway, or fix the hook output above." }
      );
    }
  }

  const manifest = await readManifest(root);
  await stripSlotLinks(slot.path, manifest);
  delete manifest[slot.path];
  await writeManifest(root, manifest);
  logger.step("🧹 swept wormhole symlinks");

  await worktreeRemove(root, slot.path, { force: options.force });
  await pruneWorktrees(root);
  logger.success(`${universeLabel(slot)} collapsed.`);
}
