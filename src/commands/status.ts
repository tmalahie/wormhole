import path from "node:path";
import pc from "picocolors";
import { logger } from "../utils/logger.js";
import { listProjectWorktrees, openProject } from "../core/worktrees.js";
import { autosyncConflictFile } from "../core/paths.js";
import { pathExists, readJson } from "../utils/fs.js";
import type { Worktree } from "../types.js";

export interface StatusOptions {
  json?: boolean;
}

interface AutosyncConflict {
  at?: string;
  machine?: string;
  detail?: string;
}

/** The durable surface for an autosync conflict — the hook has no live UI, so it
 *  drops a marker and `worm status` is where the human reliably sees it. */
async function readAutosyncConflict(): Promise<AutosyncConflict | null> {
  const file = autosyncConflictFile();
  if (!(await pathExists(file))) return null;
  try {
    return await readJson<AutosyncConflict>(file);
  } catch {
    return { detail: "unreadable conflict marker" };
  }
}

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const project = await openProject();
  const worktrees = await listProjectWorktrees(project.mainRoot, project.projectName);
  const autosyncConflict = await readAutosyncConflict();

  if (options.json) {
    console.log(JSON.stringify({ root: project.mainRoot, worktrees, autosyncConflict }, null, 2));
    return;
  }

  renderStatus(project.projectName, project.mainRoot, worktrees, project.config.slots.max);
  if (autosyncConflict) renderAutosyncConflict(autosyncConflict);
}

function renderAutosyncConflict(c: AutosyncConflict): void {
  // Rendered on stdout (like the rest of the status report) so the whole thing is
  // one cohesive block — this is the durable surface for a UI-less hook.
  logger.raw("");
  logger.raw(
    pc.yellow(`💥 autosync: ~/.worm has an unresolved conflict${c.at ? ` (since ${c.at})` : ""}.`)
  );
  if (c.detail) logger.raw(`     ${pc.dim(c.detail)}`);
  logger.raw(pc.dim("     💡 Resolve it: cd ~/.worm && git status. It clears on the next clean sync."));
}

function renderStatus(projectName: string, root: string, worktrees: Worktree[], maxSlot: number): void {
  logger.raw(`🪐 ${pc.bold("WORMHOLE STATUS")} — ${pc.bold(projectName)}  ${pc.dim(root)}`);
  logger.raw("");
  const width = Math.max(0, ...worktrees.map((w) => w.name.length));
  for (const wt of worktrees) {
    const icon = wt.isMain ? "🛸" : "🚀";
    const slot = wt.slot === null ? pc.dim("   ") : pc.cyan(`s${wt.slot}`.padStart(3));
    const branch = wt.branch ? pc.bold(wt.branch) : pc.dim("(detached)");
    const where = wt.isMain ? "" : `  ${pc.dim(path.relative(root, wt.path))}`;
    logger.raw(`  ${icon} ${slot} ${wt.name.padEnd(width)}  ${branch}${where}`);
  }
  logger.raw("");
  const used = worktrees.filter((w) => w.slot !== null).length;
  logger.raw(
    [
      pc.cyan(`🚀 ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"}`),
      pc.dim(`🎰 ${used}/${maxSlot + 1} slots in use`),
    ].join("   ")
  );
}
