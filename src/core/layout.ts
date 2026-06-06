import path from "node:path";
import { ensureSymlink } from "./symlinks.js";
import {
  globalProjectLogsDir,
  globalProjectRecipesDir,
  legacyLocalSharedDir,
  localLogsDir,
  localRecipesRoot,
  localRoot,
  managedLinksFile,
  MANAGED_LINKS_FILE_NAME,
} from "./paths.js";
import { ensureDir, fs, isSymlink, pathExists, writeTextIfMissing } from "../utils/fs.js";

/**
 * Consolidation: a project's durable state lives in the profile, and the local
 * `.worm/` is (almost) all pointers. This ensures the discoverable
 * `.worm/recipes` and `.worm/logs` are symlinks INTO the profile, migrating an
 * old project whose `.worm/recipes` / `.worm/logs` were real directories. Run
 * before materializing recipes (which write through these symlinks). Idempotent.
 */
export async function ensureLocalLayout(projectRoot: string, projectName: string): Promise<void> {
  await migrateRealDirToProfileLink(
    localRecipesRoot(projectRoot),
    globalProjectRecipesDir(projectName)
  );
  await migrateRealDirToProfileLink(localLogsDir(projectRoot), globalProjectLogsDir(projectName));
  // Generated logs must not be committed to the personal ~/.worm repo (recipe
  // artifacts in profile/recipes/ ARE durable config, so they stay tracked).
  await writeTextIfMissing(
    path.join(globalProjectLogsDir(projectName), ".gitignore"),
    "*\n!.gitignore\n"
  );
  await migrateManifestToProfile(projectRoot, projectName);
}

/**
 * Remove a stale `.worm/shared/` left by the pre-consolidation two-hop. Call
 * AFTER reconciling slot links (which re-point them straight at the profile), so
 * the links never momentarily dangle. No-op for a fresh project. Idempotent.
 */
export async function removeLegacyShared(projectRoot: string): Promise<void> {
  const shared = legacyLocalSharedDir(projectRoot);
  if (await pathExists(shared)) {
    await fs.rm(shared, { recursive: true, force: true });
  }
}

/**
 * Make `localPath` a symlink → `profilePath`. If `localPath` is currently a real
 * directory (old layout), move its contents into the profile first
 * (non-clobbering — any file already in the profile wins), then remove it so the
 * symlink can take its place.
 */
async function migrateRealDirToProfileLink(localPath: string, profilePath: string): Promise<void> {
  await ensureDir(profilePath);
  if (!(await isSymlink(localPath)) && (await pathExists(localPath))) {
    await fs.cp(localPath, profilePath, { recursive: true, force: false, errorOnExist: false });
    await fs.rm(localPath, { recursive: true, force: true });
  }
  await ensureSymlink(localPath, profilePath, { relative: false, type: "dir" });
}

/** Move a pre-consolidation `.worm/.managed-links.json` into the profile. */
async function migrateManifestToProfile(projectRoot: string, projectName: string): Promise<void> {
  const localFile = path.join(localRoot(projectRoot), MANAGED_LINKS_FILE_NAME);
  if (!(await pathExists(localFile))) return;
  const profileFile = managedLinksFile(projectName);
  if (!(await pathExists(profileFile))) {
    await ensureDir(path.dirname(profileFile));
    await fs.cp(localFile, profileFile);
  }
  await fs.rm(localFile, { force: true });
}
