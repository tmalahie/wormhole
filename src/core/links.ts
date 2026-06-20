import path from "node:path";
import { ensureSymlink } from "./symlinks.js";
import { detachedLinksFile, managedLinksFile } from "./paths.js";
import { logger } from "../utils/logger.js";
import {
  ensureDir,
  fs,
  isDirectory,
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

export interface AdoptionOperation {
  type: "move" | "link" | "create-dir" | "conflict";
  tail: string;
  slotPath: string;
  sourcePath: string;
  conflictReason?: string;
}

export interface AdoptionPlan {
  operations: AdoptionOperation[];
  hasConflicts: boolean;
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

/** Per-slot tails the user localised via `worm detach` (resolved slot path → tails). */
export type DetachRegistry = Record<string, string[]>;

export async function readDetached(projectName: string): Promise<DetachRegistry> {
  const file = detachedLinksFile(projectName);
  if (!(await pathExists(file))) return {};
  try {
    return (await readJson<DetachRegistry>(file)) ?? {};
  } catch {
    return {};
  }
}

export async function writeDetached(
  projectName: string,
  registry: DetachRegistry
): Promise<void> {
  await writeJson(detachedLinksFile(projectName), registry);
}

/**
 * Self-heal one slot's detach list: keep only tails that are still a real
 * (non-symlink) file on disk. Deleting the local file is the way to re-attach —
 * the tunnel comes back on the next `worm sync`. Mutates `registry` in place and
 * returns the live detached tails for this slot.
 */
export async function liveDetached(
  slotPath: string,
  registry: DetachRegistry
): Promise<string[]> {
  const key = path.resolve(slotPath);
  const want = registry[key] ?? [];
  const live: string[] = [];
  for (const tail of want) {
    const lp = path.join(slotPath, tail);
    if ((await pathExists(lp)) && !(await isSymlink(lp))) live.push(tail);
  }
  if (live.length > 0) registry[key] = live;
  else delete registry[key];
  return live;
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
  // Tails worm actually maintains as symlinks this run — what the manifest stores
  // (so a detached/real-file tail drops out of management cleanly).
  const managed: string[] = [];

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
    // Deref-guard (create side): a real (non-symlink) file here is a slot-local
    // override — `worm detach` made it real, or the user dropped a file in. Never
    // clobber it (ensureSymlink would throw) and stop tracking it as managed.
    if ((await pathExists(linkPath)) && !(await isSymlink(linkPath))) {
      skipped.push(link.tail);
      continue;
    }
    const res = await ensureSymlink(linkPath, link.source, { relative: false });
    if (res.created) created.push(link.tail);
    managed.push(link.tail);
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

  manifest[key] = managed;
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

/** Classification of a profile-side link source, used to decide adoption. */
type SourceState = "missing" | "empty-file" | "file" | "dir";

async function classifySource(p: string): Promise<SourceState> {
  let stat;
  try {
    stat = await fs.stat(p); // follow symlinks: we care about the real target
  } catch {
    return "missing"; // absent or dangling
  }
  if (stat.isDirectory()) return "dir";
  return stat.size === 0 ? "empty-file" : "file";
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Plan adoption operations for a slot: detect real files/dirs that live in the
 * slot but should instead live in the profile (profile-store links only — never
 * external stores). Each adopted entry is moved into the profile and replaced
 * with a symlink. Returns the planned operations plus whether any are conflicts.
 *
 * Per shared path:
 * - already a symlink → skip (idempotent; an adopted entry is left untouched).
 * - absent in the slot → nothing to adopt.
 * - absent (or only a sprouted empty placeholder) in the profile → adopt.
 * - identical regular-file content in the profile → adopt (de-duplicate).
 * - real, differing content on both sides (or a directory on either side) →
 *   conflict, surfaced cleanly rather than letting the symlink step throw.
 */
export async function planAdoption(
  slotPath: string,
  desired: ResolvedLink[]
): Promise<AdoptionPlan> {
  const operations: AdoptionOperation[] = [];
  const profileLinks = desired.filter((d) => d.sprout); // only profile-store links

  const adopt = (tail: string, source: string): void => {
    // ensureDir is idempotent, so always staging the parent is safe and simpler
    // than probing first; create-dir ops are internal (never shown to the user).
    operations.push({ type: "create-dir", tail, slotPath, sourcePath: path.dirname(source) });
    operations.push({ type: "move", tail, slotPath, sourcePath: source });
    operations.push({ type: "link", tail, slotPath, sourcePath: source });
  };
  const conflict = (tail: string, source: string, reason: string): void => {
    operations.push({ type: "conflict", tail, slotPath, sourcePath: source, conflictReason: reason });
  };

  for (const link of profileLinks) {
    const linkPath = path.join(slotPath, link.tail);

    // An adopted (or otherwise managed) entry is already a symlink — leave it.
    if (await isSymlink(linkPath)) continue;
    // Nothing real in the slot → nothing to adopt.
    if (!(await pathExists(linkPath))) continue;

    const linkIsDir = await isDirectory(linkPath);
    const source = await classifySource(link.source);

    // Profile has nothing real here (or just a sprouted empty file placeholder).
    if (source === "missing" || (source === "empty-file" && !linkIsDir)) {
      adopt(link.tail, link.source);
      continue;
    }

    // Profile already holds an identical regular file → adopt to de-duplicate.
    if (source === "file" && !linkIsDir) {
      const [a, b] = await Promise.all([readMaybe(linkPath), readMaybe(link.source)]);
      if (a !== null && a === b) {
        adopt(link.tail, link.source);
        continue;
      }
    }

    // Real content on both sides that we can't safely merge.
    conflict(
      link.tail,
      link.source,
      linkIsDir || source === "dir"
        ? "a directory exists in both the slot and the profile"
        : "the slot copy differs from the profile copy"
    );
  }

  const hasConflicts = operations.some((op) => op.type === "conflict");
  return { operations, hasConflicts };
}

/**
 * Execute adoption operations: create parent dirs, move slot entries into the
 * profile (copy-then-remove, so it works across filesystems), then symlink the
 * slot path back at the profile source. `conflict` ops are inert — callers must
 * refuse to proceed before calling this.
 */
export async function executeAdoption(
  slotPath: string,
  operations: AdoptionOperation[]
): Promise<void> {
  for (const op of operations) {
    if (op.type === "create-dir") {
      await ensureDir(op.sourcePath);
    } else if (op.type === "move") {
      const linkPath = path.join(slotPath, op.tail);
      if (await pathExists(linkPath)) {
        await fs.cp(linkPath, op.sourcePath, { recursive: true, force: true });
        await fs.rm(linkPath, { recursive: true, force: true });
      }
    } else if (op.type === "link") {
      const linkPath = path.join(slotPath, op.tail);
      await ensureSymlink(linkPath, op.sourcePath, { relative: false });
    }
  }
}

/** Collapse a leading `$HOME` to `~` for display only. */
export function tildeify(p: string): string {
  const home = process.env.HOME;
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** Render one adoption move as a themed, coloured line (shared by init & sync). */
export function formatAdoptionMove(op: AdoptionOperation): string {
  return `🌀 move+link ${logger.cyan(op.tail)} → ${logger.cyan(tildeify(op.sourcePath))}`;
}
