import path from "node:path";
import { logger } from "../utils/logger.js";
import { ensureDir, pathExists, writeJson, writeTextIfMissing } from "../utils/fs.js";
import { run } from "../utils/exec.js";
import {
  globalMultiversesDir,
  globalRoot,
  globalSharedDir,
} from "../core/paths.js";
import { DEFAULT_CONFIG } from "../types.js";

const TEMPLATE_CONFIG_NAME = "config.template.json";
const GLOBAL_RULES_NAME = "global-rules.md";
const README_NAME = "README.md";

export interface InitOptions {
  force?: boolean;
}

export async function runInit(_options: InitOptions = {}): Promise<void> {
  const root = globalRoot();
  logger.info(`🪐 Forging a new Multiverse at ${logger.dim(root)}`);

  await ensureDir(root);
  await ensureDir(globalMultiversesDir());
  await ensureDir(globalSharedDir());

  const templatePath = path.join(root, TEMPLATE_CONFIG_NAME);
  const wroteTemplate = !(await pathExists(templatePath));
  await writeJson(templatePath, DEFAULT_CONFIG);
  if (wroteTemplate) logger.step(`seeded blueprint ${logger.dim(templatePath)}`);

  const rulesPath = path.join(globalSharedDir(), GLOBAL_RULES_NAME);
  const wroteRules = await writeTextIfMissing(
    rulesPath,
    "# Global rules\n\nInstructions applied to every wormhole-managed project.\n"
  );
  if (wroteRules) logger.step(`inscribed ${logger.dim(rulesPath)}`);

  const readmePath = path.join(root, README_NAME);
  await writeTextIfMissing(
    readmePath,
    "# wormhole personal repo\n\nThis directory is managed by the `worm` CLI.\nIt holds per-project profiles (multiverses/) and shared rules (shared/).\n"
  );

  await initGitRepoIfNeeded(root);

  logger.success("Multiverse online.");
  logger.raw("");
  logger.raw(`Next: cd into a project and run ${logger.bold("worm register")} to bind it.`);
}

async function initGitRepoIfNeeded(root: string): Promise<void> {
  if (await pathExists(path.join(root, ".git"))) return;
  const { exitCode } = await run("git", ["init", "--quiet"], { cwd: root });
  if (exitCode === 0) {
    logger.step(`ignited git timeline in ${logger.dim(root)}`);
  } else {
    logger.warn(
      `Could not initialize git repo at ${root}. You can run \`git init\` there yourself later.`
    );
  }
}
