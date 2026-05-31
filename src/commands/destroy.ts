import readline from "node:readline";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs, pathExists } from "../utils/fs.js";
import { gitToplevel, readProjectName } from "../core/project.js";
import { scanUniverses } from "../core/universe.js";
import { pruneWorktrees, worktreeRemove } from "../core/git.js";
import { globalProjectDir, localRoot } from "../core/paths.js";
import { readManifest, stripSlotLinks } from "../core/links.js";
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
    throw new WormError("This project is not bound to a wormhole multiverse.", {
      hint: "Nothing to destroy. If you have leftover .worm/ state, remove it manually.",
    });
  }

  const slots = await scanUniverses(root);
  const siblings = slots.filter((s) => !s.isPrimary);
  const globalProfile = globalProjectDir(projectName);

  logger.info(`💥 About to destroy the ${logger.bold(projectName)} multiverse:`);
  if (siblings.length > 0) {
    logger.raw(`  • Remove ${siblings.length} sibling universe${siblings.length === 1 ? "" : "s"}:`);
    for (const s of siblings) {
      logger.raw(`      - ${s.name}: ${s.branch ?? "(detached)"} at ${logger.dim(s.path)}`);
    }
  }
  logger.raw(`  • Remove ${logger.dim(localRoot(root))}`);
  logger.raw(`  • Remove ${logger.dim(globalProfile)}`);
  logger.raw(`  • Slot 0 (${logger.dim(root)}) is left untouched.`);
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

  const manifest = await readManifest(root);

  // 1. Remove sibling worktrees (force so uncommitted changes don't block).
  for (const slot of siblings) {
    await stripSlotLinks(slot.path, manifest);
    await worktreeRemove(root, slot.path, { force: true });
  }
  await pruneWorktrees(root);

  // 2. Strip Slot 0's injected tunnels + recipe hooks (but never remove Slot 0 itself).
  await stripSlotLinks(root, manifest);
  await stripRecipeWiring(root, root);

  // 3. Remove local .worm/ state.
  await fs.rm(localRoot(root), { recursive: true, force: true });
  logger.step(`🧹 removed ${logger.dim(localRoot(root))}`);

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
