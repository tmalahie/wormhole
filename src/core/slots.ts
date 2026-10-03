import path from "node:path";
import { WormError } from "../utils/errors.js";
import { fs, pathExists, readJson } from "../utils/fs.js";
import { slotsFile } from "./paths.js";
import type { SlotsConfig } from "../types.js";

/**
 * Runtime slots: numbered environments (port namespaces) a worktree borrows while
 * it runs a stack. The assignment lives in the profile's slots.json — the only
 * source of truth — as `{ "<N>": { worktree, since } | null }`. A worktree has no
 * slot by default; `assign` picks the lowest free number unless told otherwise.
 *
 * Entries whose worktree no longer exists on disk are treated as free (a worktree
 * deleted behind worm's back must not hold a slot forever) and are dropped on the
 * next write.
 */

export interface SlotEntry {
  worktree: string;
  since: number;
}

export type SlotTable = Record<number, SlotEntry>;

export async function readSlots(projectName: string): Promise<SlotTable> {
  const file = slotsFile(projectName);
  if (!(await pathExists(file))) return {};
  let raw: Record<string, SlotEntry | null>;
  try {
    raw = await readJson<Record<string, SlotEntry | null>>(file);
  } catch {
    throw new WormError(`Could not parse ${file}.`, {
      hint: "Fix or delete the file — it only records which worktree holds which slot.",
    });
  }
  const table: SlotTable = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!/^\d+$/.test(key) || !entry || typeof entry.worktree !== "string") continue;
    if (!(await pathExists(entry.worktree))) continue;
    table[Number.parseInt(key, 10)] = { worktree: entry.worktree, since: entry.since ?? 0 };
  }
  return table;
}

/** Write the table with every slot 0..max listed (null = free), atomically. */
export async function writeSlots(
  projectName: string,
  table: SlotTable,
  slots: SlotsConfig
): Promise<void> {
  const out: Record<string, SlotEntry | null> = {};
  const top = Math.max(slots.max, ...Object.keys(table).map(Number));
  for (let n = 0; n <= top; n++) out[String(n)] = table[n] ?? null;
  const file = slotsFile(projectName);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + "\n");
  await fs.rename(tmp, file);
}

export function slotOf(table: SlotTable, worktreePath: string): number | null {
  const target = path.resolve(worktreePath);
  for (const [n, entry] of Object.entries(table)) {
    if (path.resolve(entry.worktree) === target) return Number(n);
  }
  return null;
}

export function freeSlots(table: SlotTable, slots: SlotsConfig): number[] {
  const free: number[] = [];
  for (let n = 0; n <= slots.max; n++) if (!table[n]) free.push(n);
  return free;
}

/**
 * Pick the slot for `worktreePath`: its current one if it has one (assigning is
 * idempotent), else `wanted`, else the lowest free. Pure — the caller writes the
 * table and runs the hooks. `changed` is false when it already held the slot.
 */
export function chooseSlot(
  table: SlotTable,
  slots: SlotsConfig,
  worktreePath: string,
  wanted?: number
): { slot: number; changed: boolean } {
  const current = slotOf(table, worktreePath);
  if (current !== null && (wanted === undefined || wanted === current)) {
    return { slot: current, changed: false };
  }
  if (current !== null) {
    throw new WormError(`This worktree already holds slot ${current}.`, {
      hint: `Release it first (\`worm slot release\`), then assign slot ${wanted}.`,
    });
  }
  if (wanted !== undefined) {
    if (!Number.isInteger(wanted) || wanted < 0 || wanted > slots.max) {
      throw new WormError(`Slot ${wanted} is out of range (0–${slots.max}).`, {
        hint: "Raise `slots.max` in the project config to allow more slots.",
      });
    }
    const holder = table[wanted];
    if (holder) {
      throw new WormError(`Slot ${wanted} is held by ${holder.worktree}.`, {
        hint: `Release it there first (\`worm slot release ${wanted}\`), or omit the number to take the lowest free slot.`,
      });
    }
    return { slot: wanted, changed: true };
  }
  const free = freeSlots(table, slots);
  if (free.length === 0) {
    throw new WormError(`All ${slots.max + 1} slots are taken.`, {
      hint: "Release one (`worm slot ls` shows who holds what), or raise `slots.max`.",
    });
  }
  return { slot: free[0]!, changed: true };
}
