import readline from "node:readline";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs, pathExists } from "../utils/fs.js";
import {
  findContainerRoot,
  readProjectName,
} from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { scanUniverses } from "../core/universe.js";
import { pruneWorktrees } from "../core/git.js";
import {
  globalProjectDir,
  localRoot,
  slotName,
  worktreeDir,
} from "../core/paths.js";
import { runCollapse } from "./collapse.js";

export interface DestroyOptions {
  force?: boolean;
}

export async function runDestroy(options: DestroyOptions = {}): Promise<void> {
  const projectRoot = await findContainerRoot();

  let projectName: string;
  try {
    projectName = await readProjectName(projectRoot);
  } catch {
    throw new WormError("This project is not bound to a wormhole multiverse.", {
      hint: "Nothing to destroy. If you have leftover .worm/ state, remove it manually.",
    });
  }

  const config = await loadLocalConfig(projectRoot);
  const slots = await scanUniverses(projectRoot, config);
  const active = slots.filter((s) => s.status === "ACTIVE");
  const globalProfile = globalProjectDir(projectName);

  logger.info(
    `💥 About to destroy the ${logger.bold(projectName)} multiverse:`
  );
  if (active.length > 0) {
    logger.raw(`  • Force-collapse ${active.length} active universe${active.length === 1 ? "" : "s"}:`);
    for (const s of active) {
      logger.raw(`      - ${s.name}: ${s.branch ?? "(detached)"} at ${logger.dim(s.srcPath)}`);
    }
  }
  logger.raw(`  • Remove ${logger.dim(localRoot(projectRoot))}`);
  logger.raw(`  • Remove ${logger.dim(globalProfile)}`);
  logger.raw("");

  if (!options.force) {
    if (!process.stdin.isTTY) {
      throw new WormError(
        "Refusing to destroy in a non-interactive shell.",
        { hint: "Re-run with --force to skip the confirmation prompt." }
      );
    }
    const ok = await confirm("Proceed?");
    if (!ok) {
      logger.info("Aborted.");
      return;
    }
  }

  // 1. Collapse active warps (with --force so uncommitted changes don't block us).
  for (const slot of active) {
    if (slot.branch) {
      await runCollapse(slot.branch, { force: true, skipHook: true });
    } else {
      // Detached worktree — no branch ref to feed runCollapse, do the bare git removal.
      await fs.rm(slot.srcPath, { recursive: true, force: true });
    }
  }

  // 2. Defensive sweep of any leftover top-level worktree dirs.
  for (let i = 0; i < config.universes_count; i += 1) {
    const wt = worktreeDir(projectRoot, projectName, slotName(i));
    if (await pathExists(wt)) {
      await fs.rm(wt, { recursive: true, force: true });
    }
  }

  await pruneWorktrees(projectRoot);

  // 3. Remove local .worm/ state.
  await fs.rm(localRoot(projectRoot), { recursive: true, force: true });
  logger.step(`🧹 removed ${logger.dim(localRoot(projectRoot))}`);

  // 4. Remove the global profile.
  if (await pathExists(globalProfile)) {
    await fs.rm(globalProfile, { recursive: true, force: true });
    logger.step(`🧹 removed ${logger.dim(globalProfile)}`);
  }

  logger.success(`💥 The ${projectName} multiverse is no more.`);
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
