import path from "node:path";
import { isDirectory, pathExists } from "../utils/fs.js";
import type { Config, UniverseSlot } from "../types.js";
import {
  localUniversesDir,
  slotName,
  slotPath,
  slotSrcPath,
} from "./paths.js";
import { listWorktrees, type WorktreeEntry } from "./git.js";

export async function scanUniverses(
  projectRoot: string,
  config: Config
): Promise<UniverseSlot[]> {
  const worktrees = await safeListWorktrees(projectRoot);
  const slots: UniverseSlot[] = [];
  for (let i = 0; i < config.universes_count; i += 1) {
    const name = slotName(i);
    const sPath = slotPath(projectRoot, name);
    const srcPath = slotSrcPath(projectRoot, name);
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
      reason: "Slot directory is missing. Run `worm register` to provision.",
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
