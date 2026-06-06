import path from "node:path";
import { ensureSymlink } from "./symlinks.js";
import { globalProjectFile, managedLinksFile } from "./paths.js";
import {
  ensureDir,
  fs,
  isSymlink,
  pathExists,
  readJson,
  writeJson,
  writeTextIfMissing,
} from "../utils/fs.js";

/** Map of resolved slot path → relative link paths worm created in that slot. */
export type LinkManifest = Record<string, string[]>;

export interface ReconcileResult {
  created: string[];
  pruned: string[];
  /** Links that were expected but are now real files (deref'd by a tool) — left untouched. */
  skipped: string[];
}

export async function readManifest(projectName: string): Promise<LinkManifest> {
  const file = managedLinksFile(projectName);
  if (!(await pathExists(file))) return {};
  try {
    return (await readJson<LinkManifest>(file)) ?? {};
  } catch {
    return {};
  }
}

export async function writeManifest(
  projectName: string,
  manifest: LinkManifest
): Promise<void> {
  await writeJson(managedLinksFile(projectName), manifest);
}

/**
 * Reconcile one slot's wormhole tunnels (shared_paths) against `desired`,
 * mutating `manifest` in place. Each tail is linked DIRECTLY at the profile
 * source (`~/.worm/multiverses/<name>/<rel>`, absolute — the `.worm/shared`
 * two-hop is gone), sprouting an empty profile source when missing. Prunes links
 * it previously managed that are no longer desired, and refuses to touch a path
 * that has become a real file. The caller persists the manifest.
 */
export async function reconcileSlotLinks(
  projectName: string,
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
    const target = globalProjectFile(projectName, rel);
    // Sprout an empty profile source so the slot link never dangles.
    if (!(await pathExists(target))) {
      await ensureDir(path.dirname(target));
      await writeTextIfMissing(target, "");
    }
    const linkPath = path.join(slotPath, rel);
    const res = await ensureSymlink(linkPath, target, { relative: false });
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
