import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs } from "../utils/fs.js";
import { gitToplevel } from "../core/project.js";
import { assertNoEnvCollision } from "../core/env.js";
import { ensureLocalLayout } from "../core/layout.js";
import {
  listProjectWorktrees,
  openProject,
  resolveWorktreeRef,
  wireWorktree,
} from "../core/worktrees.js";

/**
 * `worm wire [path]` — apply the cognitive layer (shared-path tunnels, the slot
 * env file, the Claude project-dir link, recipe hooks) to one worktree. Worktrees
 * worm creates are wired already; this is for one made by something else (plain
 * `git worktree add`, another tool) or to repair one. Idempotent; never clobbers
 * real files (the reconcile deref-guard skips them).
 */
export async function runWire(pathArg?: string): Promise<void> {
  const start = pathArg ? path.resolve(pathArg) : process.cwd();
  const top = await gitToplevel(start);
  if (!top) {
    throw new WormError(`Not inside a git worktree (looked at ${start}).`, {
      hint: "Pass a path inside a git worktree, e.g. `worm wire /path/to/worktree`.",
    });
  }
  const worktreeRoot = await fs.realpath(top);
  const project = await openProject(worktreeRoot);
  assertNoEnvCollision(project.config);
  await ensureLocalLayout(project.mainRoot, project.projectName);
  const wt = resolveWorktreeRef(worktreeRoot, await listProjectWorktrees(project.mainRoot, project.projectName));

  logger.info(
    `🔗 Wiring ${logger.bold(wt.name)} on ${logger.bold(wt.branch ?? "(detached)")} (${logger.dim(wt.path)})`
  );
  const res = await wireWorktree(project, wt);
  for (const rel of res.links.created) logger.step(`🔗 linked ${rel}`);
  for (const rel of res.links.pruned) logger.step(`🧹 pruned ${rel}`);
  for (const rel of res.links.skipped) logger.warn(`${rel} is a real file, not a managed link — left as-is.`);
  for (const rel of res.links.missing) logger.warn(`${rel} — store source not found yet; not linked.`);
  if (res.env?.change === "written") logger.step(`📝 generated ${res.env.file} (slot ${wt.slot})`);
  if (res.env?.change === "removed") logger.step(`🧹 removed ${res.env.file} (no slot)`);
  if (res.claudeDir === "linked") logger.step("🔗 Claude project dir → main worktree's");
  if (res.claudeDir === "real-dir") {
    logger.warn("Claude project dir for this worktree is a real directory — merge it into the main one by hand.");
  }
  if (res.recipeHooksChanged) logger.step("⚡ wired recipe hooks");
  logger.success(`Wired ${wt.name} into ${project.projectName}'s cognitive layer.`);
}
