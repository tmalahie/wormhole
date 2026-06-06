import path from "node:path";
import { ensureSymlink } from "./symlinks.js";
import { managedLinksFile } from "./paths.js";
import {
  ensureDir,
  fs,
  isSymlink,
  pathExists,
  readJson,
  writeJson,
  writeTextIfMissing,
} from "../utils/fs.js";
import type { ResolvedLink } from "./stores.js";

/** Map of resolved slot path → relative link paths worm created in that slot. */
export type LinkManifest = Record<string, string[]>;

export interface ReconcileResult {
  created: string[];
  pruned: string[];
  /** Links that were expected but are now real files (deref'd by a tool) — left untouched. */
  skipped: string[];
  /** External-store tails whose source doesn't exist yet — not linked this run. */
  missing: string[];
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
 * Reconcile one slot's wormhole tunnels against `desired` (already resolved to
 * concrete sources by `resolveStoreLinks`), mutating `manifest` in place. Each
 * tail is linked DIRECTLY at its source (absolute — the `.worm/shared` two-hop
 * is gone): a profile source is sprouted empty when missing; an external-store
 * source that doesn't exist yet is skipped (reported as `missing`, not
 * fabricated). Prunes links it previously managed that are no longer desired,
 * and refuses to touch a path that has become a real file. Caller persists the
 * manifest.
 */
export async function reconcileSlotLinks(
  slotPath: string,
  desired: ResolvedLink[],
  manifest: LinkManifest
): Promise<ReconcileResult> {
  const key = path.resolve(slotPath);
  const previous = manifest[key] ?? [];
  const created: string[] = [];
  const pruned: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  for (const link of desired) {
    let sourceExists = await pathExists(link.source);
    // Sprout an empty profile source so the slot link never dangles; never
    // fabricate a file inside an external store.
    if (!sourceExists && link.sprout) {
      await ensureDir(path.dirname(link.source));
      await writeTextIfMissing(link.source, "");
      sourceExists = true;
    }
    if (!sourceExists) {
      missing.push(link.tail);
      continue;
    }
    const linkPath = path.join(slotPath, link.tail);
    const res = await ensureSymlink(linkPath, link.source, { relative: false });
    if (res.created) created.push(link.tail);
  }

  const desiredTails = desired.map((d) => d.tail);
  for (const rel of previous) {
    if (desiredTails.includes(rel)) continue;
    const linkPath = path.join(slotPath, rel);
    if (await isSymlink(linkPath)) {
      await fs.unlink(linkPath);
      pruned.push(rel);
    } else if (await pathExists(linkPath)) {
      skipped.push(rel);
    }
  }

  manifest[key] = desiredTails;
  return { created, pruned, skipped, missing };
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
