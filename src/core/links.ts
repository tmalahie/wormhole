import path from "node:path";
import { ensureSymlink } from "./symlinks.js";
import { localSharedFile, managedLinksFile } from "./paths.js";
import { fs, isSymlink, pathExists, readJson, writeJson } from "../utils/fs.js";

/** Map of resolved slot path → relative link paths worm created in that slot. */
export type LinkManifest = Record<string, string[]>;

export interface ReconcileResult {
  created: string[];
  pruned: string[];
  /** Links that were expected but are now real files (deref'd by a tool) — left untouched. */
  skipped: string[];
}

export async function readManifest(slot0Root: string): Promise<LinkManifest> {
  const file = managedLinksFile(slot0Root);
  if (!(await pathExists(file))) return {};
  try {
    return (await readJson<LinkManifest>(file)) ?? {};
  } catch {
    return {};
  }
}

export async function writeManifest(
  slot0Root: string,
  manifest: LinkManifest
): Promise<void> {
  await writeJson(managedLinksFile(slot0Root), manifest);
}

/**
 * Reconcile one slot's wormhole tunnels (shared_paths) against `desired`,
 * mutating `manifest` in place. Creates missing links, prunes links it
 * previously managed that are no longer desired, and refuses to touch a path
 * that has become a real file. The caller persists the manifest.
 */
export async function reconcileSlotLinks(
  slot0Root: string,
  slotPath: string,
  desired: string[],
  manifest: LinkManifest
): Promise<ReconcileResult> {
  const key = path.resolve(slotPath);
  const previous = manifest[key] ?? [];
  const created: string[] = [];
  const pruned: string[] = [];
  const skipped: string[] = [];

  for (const rel of desired) {
    const linkPath = path.join(slotPath, rel);
    const target = localSharedFile(slot0Root, rel);
    const res = await ensureSymlink(linkPath, target, { relative: true });
    if (res.created) created.push(rel);
  }

  for (const rel of previous) {
    if (desired.includes(rel)) continue;
    const linkPath = path.join(slotPath, rel);
    if (await isSymlink(linkPath)) {
      await fs.unlink(linkPath);
      pruned.push(rel);
    } else if (await pathExists(linkPath)) {
      skipped.push(rel);
    }
  }

  manifest[key] = [...desired];
  return { created, pruned, skipped };
}

/**
 * Unlink every managed symlink in a slot (used before removing the worktree).
 * Only touches entries recorded in the manifest, and only if still a symlink.
 */
export async function stripSlotLinks(
  slotPath: string,
  manifest: LinkManifest
): Promise<void> {
  const rels = manifest[path.resolve(slotPath)] ?? [];
  for (const rel of rels) {
    const linkPath = path.join(slotPath, rel);
    if (await isSymlink(linkPath)) {
      await fs.unlink(linkPath);
    }
  }
}
