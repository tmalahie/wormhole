import path from "node:path";
import pc from "picocolors";
import { logger, reserveStdout } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { dirtyFiles } from "../core/git.js";
import {
  createWorktree,
  listProjectWorktrees,
  openProject,
  removeWorktree,
  resolveWorktreeRef,
} from "../core/worktrees.js";

export interface WorktreeAddOptions {
  name?: string;
  base?: string;
  setup?: boolean; // commander's --no-setup → setup: false
  json?: boolean;
}

/** `worm worktree add <branch>` — create, wire and set up a worktree. */
export async function runWorktreeAdd(branch: string, options: WorktreeAddOptions = {}): Promise<void> {
  if (options.json) reserveStdout();
  const project = await openProject();
  logger.info(`🌱 Adding a worktree for ${logger.bold(branch)}`);
  const wt = await createWorktree(project, {
    branch,
    name: options.name,
    base: options.base,
    noSetup: options.setup === false,
  });
  if (options.json) {
    process.stdout.write(JSON.stringify({ path: wt.path, name: wt.name, branch: wt.branch }) + "\n");
    return;
  }
  logger.success(`${wt.name} is ready on ${logger.bold(branch)}.`);
  process.stdout.write(wt.path + "\n");
}

export interface WorktreeRemoveOptions {
  force?: boolean;
  deleteBranch?: boolean;
  skipHook?: boolean;
}

/** `worm worktree rm <ref>` — remove a linked worktree and what worm attached to it. */
export async function runWorktreeRemove(ref: string, options: WorktreeRemoveOptions = {}): Promise<void> {
  const project = await openProject();
  const wt = resolveWorktreeRef(ref, await listProjectWorktrees(project.mainRoot, project.projectName));
  logger.info(`🧹 Removing ${logger.bold(wt.name)} (${logger.dim(wt.path)})`);
  const res = await removeWorktree(project, wt, options);
  if (res.releasedSlot !== null) logger.step(`released slot ${res.releasedSlot}`);
  if (res.branchError) logger.warn(`kept branch ${res.branchKept}: ${res.branchError}`);
  else if (res.branchKept) logger.step(`kept branch ${res.branchKept}`);
  logger.success(`${wt.name} removed.`);
}

/** `worm worktree ls` — every worktree, main first, with branch, dirt and slot. */
export async function runWorktreeList(options: { json?: boolean } = {}): Promise<void> {
  const project = await openProject();
  const worktrees = await listProjectWorktrees(project.mainRoot, project.projectName);
  const rows = await Promise.all(
    worktrees.map(async (w) => ({ ...w, dirty: (await dirtyFiles(w.path)).length > 0 }))
  );
  if (options.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const slot = r.slot === null ? pc.dim("  -") : pc.cyan(`s${r.slot}`.padStart(3));
    const branch = r.branch ? pc.bold(r.branch) : pc.dim("(detached)");
    const dirty = r.dirty ? pc.yellow(" *") : "";
    const where = r.isMain ? r.path : path.relative(project.mainRoot, r.path);
    logger.raw(`  ${slot}  ${r.name.padEnd(width)}  ${branch}${dirty}  ${pc.dim(where)}`);
  }
}

/** `worm worktree path <ref>` — print a worktree's path (for `worm cd`). */
export async function runWorktreePath(ref: string): Promise<void> {
  if (!ref) throw new WormError("Missing worktree name, branch or slot number.");
  const project = await openProject();
  const wt = resolveWorktreeRef(ref, await listProjectWorktrees(project.mainRoot, project.projectName));
  process.stdout.write(wt.path + "\n");
}
