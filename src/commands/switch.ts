import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { findSlot0Root } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { scanUniverses, universeLabel } from "../core/universe.js";
import { switchBranch } from "../core/git.js";
import { hookEnv, runHook } from "../core/hooks.js";

export interface SwitchOptions {
  create?: boolean;
  skipHook?: boolean;
}

/**
 * Switch the current slot's branch in place (the daily driver) and re-run the
 * warm-up hook. Plain `git switch` works too — this just adds the on_create
 * hook and the "branch already checked out elsewhere" guard.
 */
export async function runSwitch(
  branch: string,
  options: SwitchOptions = {}
): Promise<void> {
  if (!branch || branch.trim().length === 0) {
    throw new WormError("Branch name is required.", {
      hint: "Usage: worm switch <branch>",
    });
  }

  const root = await findSlot0Root();
  const config = await loadLocalConfig(root);
  const slots = await scanUniverses(root);

  const cwd = process.cwd();
  const here =
    slots.find((s) => isInsideDir(cwd, s.path)) ??
    slots.find((s) => s.isPrimary);
  if (!here) {
    throw new WormError("Could not determine which universe you're in.", {
      hint: "Run `worm switch` from inside a slot's worktree.",
    });
  }

  const elsewhere = slots.find(
    (s) => s.branch === branch && path.resolve(s.path) !== path.resolve(here.path)
  );
  if (elsewhere) {
    throw new WormError(
      `Branch "${branch}" is already checked out in ${universeLabel(elsewhere)}.`,
      { hint: `git refuses two worktrees on one branch. cd ${elsewhere.path}` }
    );
  }

  await switchBranch(here.path, branch, { create: options.create });
  logger.step(`🚀 ${here.name} → ${branch}`);

  if (!options.skipHook && config.hooks.on_create) {
    const result = await runHook("on_create", config.hooks.on_create, {
      cwd: here.path,
      env: hookEnv(root, { ...here, branch }, branch),
    });
    if (result.ran && result.exitCode !== 0) {
      logger.warn(`on_create hook exited with code ${result.exitCode}.`);
    }
  }

  logger.success(`${universeLabel(here)} now on ${logger.bold(branch)}.`);
}

function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
