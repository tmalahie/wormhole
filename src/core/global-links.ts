import os from "node:os";
import path from "node:path";
import { ensureSymlink } from "./symlinks.js";
import { globalManagedLinksFile, globalRoot, globalSharedDir, MANAGED_LINKS_FILE_NAME } from "./paths.js";
import { ensureDir, fs, isDirectory, isSymlink, pathExists, readJson, writeJson } from "../utils/fs.js";
import { isWormError } from "../utils/errors.js";
import type { LinkManifest, ReconcileResult } from "./links.js";

/**
 * HOME-scope shared links: the global-scope analogue of a project's per-slot
 * tunnels. Each tail in the global `shared_paths` is linked as `~/<tail>` →
 * `~/.worm/shared/<tail>` (absolute), so machine-wide setup (e.g.
 * `~/.claude/commands`) lives in the personal `~/.worm` repo. Reconcile records
 * what it created in a global manifest so prune only touches its own links and
 * never a real user file.
 */

export async function readGlobalManifest(): Promise<LinkManifest> {
  const file = globalManagedLinksFile();
  if (!(await pathExists(file))) return {};
  try {
    return (await readJson<LinkManifest>(file)) ?? {};
  } catch {
    return {};
  }
}

export async function writeGlobalManifest(manifest: LinkManifest): Promise<void> {
  await writeGlobalManifestIgnored();
  await writeJson(globalManagedLinksFile(), manifest);
}

/**
 * Reconcile HOME-scope links against `desired`, mutating `manifest` in place.
 * Links `~/<tail>` → `~/.worm/shared/<tail>`, sprouting the shared source as an
 * empty dir when missing. Prunes previously-managed links no longer desired, and
 * leaves a path that has become a real file/dir untouched (reported as skipped).
 */
export async function reconcileGlobalLinks(
  desired: string[],
  manifest: LinkManifest
): Promise<ReconcileResult> {
  const home = os.homedir();
  const key = path.resolve(home);
  const previous = manifest[key] ?? [];
  const created: string[] = [];
  const pruned: string[] = [];
  const skipped: string[] = [];

  for (const rel of desired) {
    const source = path.join(globalSharedDir(), rel);
    const target = path.join(home, rel);
    let type: "file" | "dir" = "dir";
    if (await pathExists(source)) {
      type = (await isDirectory(source)) ? "dir" : "file";
    } else {
      // Sprout an empty shared source (global setups are conventionally dirs).
      await ensureDir(source);
    }
    try {
      const res = await ensureSymlink(target, source, { relative: false, type });
      if (res.created) created.push(rel);
    } catch (err) {
      // A real file/dir already lives at the target — don't clobber it.
      if (isWormError(err)) {
        skipped.push(rel);
        continue;
      }
      throw err;
    }
  }

  for (const rel of previous) {
    if (desired.includes(rel)) continue;
    const target = path.join(home, rel);
    if (await isSymlink(target)) {
      await fs.unlink(target);
      pruned.push(rel);
    } else if (await pathExists(target)) {
      skipped.push(rel);
    }
  }

  manifest[key] = [...desired];
  return { created, pruned, skipped };
}

/**
 * Keep the global manifest out of the personal `~/.worm` git repo (the per-slot
 * manifest is hidden by `.worm/.gitignore = *`; the global root has no blanket
 * ignore, so add a targeted line). Idempotent.
 */
async function writeGlobalManifestIgnored(): Promise<void> {
  const gitignore = path.join(globalRoot(), ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gitignore, "utf8");
  } catch {
    // no existing .gitignore — we'll create one
  }
  if (content.split("\n").includes(MANAGED_LINKS_FILE_NAME)) return;
  const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignore, content + sep + MANAGED_LINKS_FILE_NAME + "\n", "utf8");
}
