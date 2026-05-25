import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { ensureDir, fs, pathExists } from "../utils/fs.js";
import { runOrThrow } from "../utils/exec.js";
import { bindProject, type InitOptions } from "./init.js";

export interface CloneOptions {
  name?: string;
  universes?: number;
  template?: string;
  force?: boolean;
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

  const containerName =
    target ?? deriveNameFromUrl(url);
  const containerPath = path.isAbsolute(containerName)
    ? containerName
    : path.resolve(process.cwd(), containerName);

  if (await pathExists(containerPath)) {
    const entries = await fs.readdir(containerPath);
    if (entries.length > 0) {
      throw new WormError(`${containerPath} already exists and is not empty.`, {
        hint: "Pick a different path, or remove the existing directory first.",
      });
    }
  }

  await ensureDir(containerPath);

  const barePath = path.join(containerPath, ".bare");
  logger.info(`🪐 Cloning ${logger.bold(url)} into ${logger.bold(containerPath)}`);
  await runOrThrow(
    "git",
    ["clone", "--bare", url, barePath],
    {},
    `git clone --bare failed for ${url}`
  );
  logger.step(`📦 bare clone at .bare/`);

  // The `.git` pointer file turns the container into a "fake working tree" so
  // git commands run from the container resolve to the bare clone. The worktrees
  // worm creates as siblings will each have their own .git pointing back here.
  await fs.writeFile(
    path.join(containerPath, ".git"),
    "gitdir: ./.bare\n",
    "utf8"
  );
  logger.step(`🔗 wrote .git → ./.bare pointer`);

  const initOptions: InitOptions = {
    name: options.name,
    universes: options.universes,
    template: options.template,
    force: options.force,
  };
  await bindProject(containerPath, initOptions);
}

/**
 * Best-effort derivation of a container directory name from a clone URL.
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
