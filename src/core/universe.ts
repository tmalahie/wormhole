import path from "node:path";
import { isDirectory, pathExists } from "../utils/fs.js";
import { WormError } from "../utils/errors.js";
import type { Config, UniverseSlot } from "../types.js";
import {
  localUniversesDir,
  slotName,
  slotPath,
  worktreeDir,
} from "./paths.js";
import { readProjectName } from "./project.js";
import { listWorktrees, type WorktreeEntry } from "./git.js";

export async function scanUniverses(
  projectRoot: string,
  config: Config
): Promise<UniverseSlot[]> {
  const projectName = await readProjectName(projectRoot);
  const worktrees = await safeListWorktrees(projectRoot);
  const slots: UniverseSlot[] = [];
  for (let i = 0; i < config.universes_count; i += 1) {
    const name = slotName(i);
    const sPath = slotPath(projectRoot, name);
    const srcPath = worktreeDir(projectRoot, projectName, name);
    slots.push(await classifySlot(name, sPath, srcPath, worktrees));
  }
  return slots;
}

async function classifySlot(
  name: string,
  sPath: string,
  srcPath: string,
  worktrees: WorktreeEntry[]
): Promise<UniverseSlot> {
  if (!(await isDirectory(sPath))) {
    return {
      name,
      slotPath: sPath,
      srcPath,
      status: "BROKEN",
      reason: "Slot directory is missing. Run `worm init` to provision.",
    };
  }

  const srcExists = await pathExists(srcPath);
  const matched = worktrees.find((wt) => path.resolve(wt.path) === path.resolve(srcPath));

  if (matched) {
    return {
      name,
      slotPath: sPath,
      srcPath,
      status: "ACTIVE",
      branch: matched.branch ?? (matched.detached ? "(detached)" : undefined),
    };
  }

  if (srcExists) {
    return {
      name,
      slotPath: sPath,
      srcPath,
      status: "BROKEN",
      reason: "src/ exists but is not a registered worktree. Run `worm collapse` or remove it manually.",
    };
  }

  return { name, slotPath: sPath, srcPath, status: "STABLE" };
}

export function pickFreeSlot(slots: UniverseSlot[]): UniverseSlot | null {
  return slots.find((s) => s.status === "STABLE") ?? null;
}

export function findSlotByBranch(
  slots: UniverseSlot[],
  branch: string
): UniverseSlot | null {
  return (
    slots.find((s) => s.status === "ACTIVE" && s.branch === branch) ?? null
  );
}

/**
 * Resolve a user-supplied ref ("0", "main", "feat/foo") to a slot.
 * Numeric strings → look up by slot index. Otherwise → look up by branch name.
 *
 * Throws WormError with a helpful hint when nothing matches.
 */
export function resolveSlotRef(
  ref: string,
  slots: UniverseSlot[],
  options: { requireActive?: boolean } = {}
): UniverseSlot {
  if (/^\d+$/.test(ref)) {
    const index = Number.parseInt(ref, 10);
    const wanted = slotName(index);
    const slot = slots.find((s) => s.name === wanted);
    if (!slot) {
      throw new WormError(
        `Slot index ${index} is out of range (0..${slots.length - 1}).`
      );
    }
    if (options.requireActive && slot.status !== "ACTIVE") {
      throw new WormError(
        `${universeLabel(slot)} (${slot.name}) is not active (status: ${slot.status}).`,
        { hint: "Run `worm status` to see what's currently warped." }
      );
    }
    return slot;
  }

  const byBranch = slots.find((s) => s.status === "ACTIVE" && s.branch === ref);
  if (byBranch) return byBranch;

  throw new WormError(`Branch "${ref}" is not warped into any universe.`, {
    hint: "Run `worm status` to see active branches, or pass a slot index (e.g. `0`).",
  });
}

async function safeListWorktrees(projectRoot: string): Promise<WorktreeEntry[]> {
  try {
    return await listWorktrees(projectRoot);
  } catch {
    return [];
  }
}

export function describeUniversesRoot(projectRoot: string): string {
  return localUniversesDir(projectRoot);
}

export function universeLabel(slot: UniverseSlot | string): string {
  const name = typeof slot === "string" ? slot : slot.name;
  const match = name.match(/^uni-(\d+)$/);
  return match ? `Universe ${match[1]}` : name;
}
