import path from "node:path";
import { WormError } from "../utils/errors.js";
import type { UniverseSlot } from "../types.js";
import { SLOT_DIR_INFIX } from "./paths.js";
import { listWorktrees, type WorktreeEntry } from "./git.js";

/**
 * Enumerate the permanent universe pool by reading `git worktree list`.
 * The pool is EMERGENT: Slot 0 is the primary working tree, and every linked
 * worktree named `<project>-uni<N>` (a sibling of Slot 0) is universe N. Any
 * other worktree git knows about is ignored.
 */
export async function scanUniverses(slot0Root: string): Promise<UniverseSlot[]> {
  const worktrees = await safeListWorktrees(slot0Root);
  const base = path.basename(slot0Root);
  const parent = path.dirname(slot0Root);
  const slots: UniverseSlot[] = [];
  for (const wt of worktrees) {
    if (wt.bare) continue;
    const index = slotIndexForPath(slot0Root, base, parent, wt.path);
    if (index === null) continue;
    slots.push({
      index,
      name: index === 0 ? "main" : String(index),
      isPrimary: index === 0,
      path: path.resolve(wt.path),
      status: "READY",
      branch: wt.branch ?? undefined,
      detached: wt.detached,
    });
  }
  slots.sort((a, b) => a.index - b.index);
  return slots;
}

function slotIndexForPath(
  slot0Root: string,
  base: string,
  parent: string,
  wtPath: string
): number | null {
  const resolved = path.resolve(wtPath);
  if (resolved === path.resolve(slot0Root)) return 0;
  if (path.resolve(path.dirname(resolved)) !== path.resolve(parent)) return null;
  const name = path.basename(resolved);
  const prefix = `${base}${SLOT_DIR_INFIX}`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number.parseInt(rest, 10) : null;
}

/** Smallest sibling index (>= 1) not already in use. */
export function nextFreeIndex(slots: UniverseSlot[]): number {
  const used = new Set(slots.map((s) => s.index));
  let i = 1;
  while (used.has(i)) i += 1;
  return i;
}

export function findSlotByBranch(
  slots: UniverseSlot[],
  branch: string
): UniverseSlot | null {
  return slots.find((s) => s.branch === branch) ?? null;
}

/**
 * Resolve a user-supplied ref ("0", "1", "main", "feat/foo") to a slot.
 * Numeric → slot index. Otherwise → the slot currently on that branch.
 */
export function resolveSlotRef(ref: string, slots: UniverseSlot[]): UniverseSlot {
  if (/^\d+$/.test(ref)) {
    const index = Number.parseInt(ref, 10);
    const slot = slots.find((s) => s.index === index);
    if (!slot) {
      throw new WormError(`No universe with index ${index}.`, {
        hint: "Run `worm status` to list the pool.",
      });
    }
    return slot;
  }
  const byBranch = slots.find((s) => s.branch === ref);
  if (byBranch) return byBranch;
  throw new WormError(`No universe matches "${ref}".`, {
    hint: "Pass a slot index (e.g. `1`) or a branch currently checked out in a slot.",
  });
}

export function universeLabel(slot: UniverseSlot | string): string {
  if (typeof slot === "string") {
    return slot === "main" ? "Slot 0 (main)" : slot;
  }
  return slot.isPrimary ? "Slot 0 (main)" : `Universe ${slot.index}`;
}

async function safeListWorktrees(slot0Root: string): Promise<WorktreeEntry[]> {
  try {
    return await listWorktrees(slot0Root);
  } catch {
    return [];
  }
}
