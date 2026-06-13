import path from "node:path";
import { ensureSymlink } from "./symlinks.js";
import {
  globalProjectDir,
  globalProjectLogsDir,
  globalProjectRecipesDir,
  localLogsDir,
  localRecipesRoot,
} from "./paths.js";
import { ensureDir, writeTextIfMissing } from "../utils/fs.js";

/**
 * A project's durable state (recipe artifacts, logs) lives in the profile; the
 * local `.worm/` holds symlinks into it. This makes `.worm/recipes` and
 * `.worm/logs` point at the profile (creating the profile dirs as needed). Run
 * before materializing recipes, which write through these symlinks. Idempotent.
 */
export async function ensureLocalLayout(projectRoot: string, projectName: string): Promise<void> {
  await ensureProfileLink(localRecipesRoot(projectRoot), globalProjectRecipesDir(projectName));
  await ensureProfileLink(localLogsDir(projectRoot), globalProjectLogsDir(projectName));
  // Generated logs must not be committed to the personal ~/.worm repo (recipe
  // artifacts in profile/recipes/ ARE durable config, so they stay tracked).
  await writeTextIfMissing(
    path.join(globalProjectLogsDir(projectName), ".gitignore"),
    "*\n!.gitignore\n"
  );
  // Secrets pulled into the profile (e.g. a shared `.env`) must never be
  // committed to the personal ~/.worm repo. Seed a project-level ignore.
  await writeTextIfMissing(
    path.join(globalProjectDir(projectName), ".gitignore"),
    ".env\n"
  );
}

/** Make `.worm/<x>` a symlink → its profile dir (creating the dir first). */
async function ensureProfileLink(localPath: string, profilePath: string): Promise<void> {
  await ensureDir(profilePath);
  await ensureSymlink(localPath, profilePath, { relative: false, type: "dir" });
}
