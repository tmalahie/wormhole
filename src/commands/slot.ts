import pc from "picocolors";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { freeSlots, readSlots } from "../core/slots.js";
import {
  assignSlot,
  listProjectWorktrees,
  openProject,
  releaseSlot,
  resolveWorktreeRef,
  worktreeAt,
} from "../core/worktrees.js";
import type { Worktree } from "../types.js";

/**
 * `worm slot …` — runtime slots are numbered port namespaces a worktree borrows to
 * run its stack. A worktree holds at most one; slots.json in the profile is the
 * source of truth; assigning renders the env file and runs `on_assign`.
 */

async function here(): Promise<{ project: Awaited<ReturnType<typeof openProject>>; worktrees: Worktree[] }> {
  const project = await openProject();
  const worktrees = await listProjectWorktrees(project.mainRoot, project.projectName);
  return { project, worktrees };
}

function current(worktrees: Worktree[]): Worktree {
  const wt = worktreeAt(process.cwd(), worktrees);
  if (!wt) throw new WormError("The current directory is not inside a worktree of this project.");
  return wt;
}

function parseSlot(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new WormError(`"${raw}" is not a slot number.`);
  return Number.parseInt(raw, 10);
}

/** `worm slot ls` */
export async function runSlotList(options: { json?: boolean } = {}): Promise<void> {
  const { project, worktrees } = await here();
  const table = await readSlots(project.projectName);
  const max = Math.max(project.config.slots.max, ...Object.keys(table).map(Number));
  const rows = [];
  for (let n = 0; n <= max; n++) {
    const entry = table[n];
    const wt = entry ? worktrees.find((w) => w.path === entry.worktree) : undefined;
    rows.push({
      slot: n,
      worktree: entry?.worktree ?? null,
      name: wt?.name ?? null,
      branch: wt?.branch ?? null,
      since: entry?.since ?? null,
    });
  }
  if (options.json) {
    const free = freeSlots(table, project.config.slots);
    process.stdout.write(JSON.stringify({ step: project.config.slots.step, slots: rows, free }, null, 2) + "\n");
    return;
  }
  for (const r of rows) {
    if (!r.worktree) {
      logger.raw(`  ${pc.dim(`s${r.slot}`)}  ${pc.dim("free")}`);
      continue;
    }
    logger.raw(`  ${pc.cyan(`s${r.slot}`)}  ${pc.bold(r.name ?? r.worktree)}  ${pc.dim(r.branch ?? "")}`);
  }
}

/** `worm slot assign [<worktree>] [<N>]` — defaults: the cwd's worktree, the lowest free slot. */
export async function runSlotAssign(a?: string, b?: string): Promise<void> {
  const { project, worktrees } = await here();
  // One argument: a bare number is the slot (for the cwd's worktree); anything else is a worktree.
  let wtRef: string | undefined = a;
  let slotRef: string | undefined = b;
  if (a !== undefined && b === undefined && /^\d+$/.test(a)) {
    wtRef = undefined;
    slotRef = a;
  }
  const wt = wtRef ? resolveWorktreeRef(wtRef, worktrees) : current(worktrees);
  const res = await assignSlot(project, wt, slotRef === undefined ? undefined : parseSlot(slotRef));
  if (res.changed) logger.success(`${wt.name} → slot ${res.slot}`);
  else logger.info(`${wt.name} already holds slot ${res.slot}.`);
}

/** `worm slot release [<worktree>|<N>]` — default: the cwd's worktree. */
export async function runSlotRelease(ref?: string): Promise<void> {
  const { project, worktrees } = await here();
  const wt = ref ? resolveWorktreeRef(ref, worktrees) : current(worktrees);
  const released = await releaseSlot(project, wt);
  if (released === null) logger.info(`${wt.name} holds no slot.`);
  else logger.success(`${wt.name} released slot ${released}.`);
}

/** `worm slot current` — prints the cwd's slot; exit 1 when it holds none. */
export async function runSlotCurrent(): Promise<void> {
  const { worktrees } = await here();
  const wt = current(worktrees);
  if (wt.slot === null) {
    logger.error(`${wt.name} holds no slot.`);
    logger.hint("Assign one with `worm slot assign` (or from the control plane).");
    process.exit(1);
  }
  process.stdout.write(`${wt.slot}\n`);
}
