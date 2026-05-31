import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs, pathExists } from "../utils/fs.js";
import { runOrThrow } from "../utils/exec.js";
import { bindProject } from "./init.js";

export interface CloneOptions {
  name?: string;
  template?: string;
  force?: boolean;
  skipHook?: boolean;
}

export async function runClone(
  url: string,
  target: string | undefined,
  options: CloneOptions = {}
): Promise<void> {
  if (!url || url.trim().length === 0) {
    throw new WormError("Repository URL is required.", {
      hint: "Usage: worm clone <url> [path]",
    });
  }

  const name = target ?? deriveNameFromUrl(url);
  const dest = path.isAbsolute(name) ? name : path.resolve(process.cwd(), name);

  if (await pathExists(dest)) {
    const entries = await fs.readdir(dest);
    if (entries.length > 0) {
      throw new WormError(`${dest} already exists and is not empty.`, {
        hint: "Pick a different path, or remove the existing directory first.",
      });
    }
  }

  // A plain (non-bare) clone: the checkout itself becomes Slot 0. Origin and
  // remote-tracking refs are set up by git, so no refspec patching needed.
  logger.info(`🪐 Cloning ${logger.bold(url)} into ${logger.bold(dest)}`);
  await runOrThrow("git", ["clone", url, dest], {}, `git clone failed for ${url}`);
  logger.step("📦 cloned (Slot 0)");

  await bindProject(dest, {
    name: options.name,
    template: options.template,
    force: options.force,
    skipHook: options.skipHook,
  });
}

/**
 * Best-effort derivation of a directory name from a clone URL.
 * Mirrors `git clone <url>`'s default behavior.
 */
export function deriveNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const match = trimmed.match(/[/:]([^/:]+?)(\.git)?$/);
  const name = match?.[1];
  if (!name) {
    throw new WormError(`Could not derive a directory name from "${url}".`, {
      hint: "Pass an explicit path: worm clone <url> <path>",
    });
  }
  return name;
}
