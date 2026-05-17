import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import {
  ensureDir,
  pathExists,
  writeTextIfMissing,
} from "../utils/fs.js";
import {
  deriveProjectName,
  ensureGitignoreEntry,
  findProjectRoot,
} from "../core/project.js";
import {
  defaultConfig,
  globalProfileExists,
  loadGlobalConfig,
  saveGlobalConfig,
} from "../core/config.js";
import {
  globalProjectConfig,
  globalProjectDir,
  globalProjectFile,
  globalRoot,
  localConfigFile,
  localRoot,
  localSharedDir,
  localSharedFile,
  localUniversesDir,
  slotName,
  slotPath,
} from "../core/paths.js";
import { ensureSymlink } from "../core/symlinks.js";

export interface RegisterOptions {
  name?: string;
  universes?: number;
  force?: boolean;
}

export async function runRegister(options: RegisterOptions = {}): Promise<void> {
  if (!(await pathExists(globalRoot()))) {
    throw new WormError("Global wormhole root does not exist yet.", {
      hint: "Run `worm init` first.",
    });
  }

  const projectRoot = await findProjectRoot();
  const projectName = options.name ?? deriveProjectName(projectRoot);
  logger.info(`🛸 Anchoring ${logger.bold(projectName)} to the Multiverse (${logger.dim(projectRoot)})`);

  const existed = await globalProfileExists(projectName);
  const config = await prepareGlobalProfile(projectName, options, existed);

  await ensureDir(localRoot(projectRoot));
  await ensureDir(localSharedDir(projectRoot));
  await ensureDir(localUniversesDir(projectRoot));

  await ensureSymlink(
    localConfigFile(projectRoot),
    globalProjectConfig(projectName),
    { relative: false, type: "file" }
  );
  logger.step(`🪢 linked config.json → ${logger.dim(globalProjectConfig(projectName))}`);

  for (const sharedPath of config.shared_paths) {
    await provisionSharedPath(projectRoot, projectName, sharedPath);
  }

  for (let i = 1; i <= config.universes_count; i += 1) {
    await ensureDir(slotPath(projectRoot, slotName(i)));
  }
  logger.step(
    `🌌 carved ${config.universes_count} universe slot${config.universes_count === 1 ? "" : "s"}`
  );

  const gitignore = await ensureGitignoreEntry(projectRoot);
  if (gitignore.updated) {
    logger.step("📝 appended .worm/ to .gitignore");
  }

  logger.success(
    existed
      ? `Reused global profile; refreshed Multiverse layout for ${projectName}.`
      : `${projectName} is now bound to the Multiverse.`
  );
  logger.raw("");
  logger.raw(`Inspect with ${logger.bold("worm scan")}.`);
}

async function prepareGlobalProfile(
  projectName: string,
  options: RegisterOptions,
  existed: boolean
) {
  const projectDir = globalProjectDir(projectName);
  await ensureDir(projectDir);

  let config = existed ? await loadGlobalConfig(projectName) : defaultConfig();
  if (options.universes !== undefined) {
    if (existed && config.universes_count !== options.universes && !options.force) {
      throw new WormError(
        `Profile already exists with universes_count=${config.universes_count}. Refusing to change it.`,
        { hint: "Pass --force to overwrite, or edit the config file manually." }
      );
    }
    config = { ...config, universes_count: options.universes };
  }

  await saveGlobalConfig(projectName, config);

  await writeTextIfMissing(
    globalProjectFile(projectName, "CLAUDE.local.md"),
    `# CLAUDE.local.md\n\nAgent instructions for the ${projectName} project.\n`
  );
  await writeTextIfMissing(
    globalProjectFile(projectName, "SKILL.md"),
    `# SKILL.md\n\nSpecialized skills the agent should bring to ${projectName}.\n`
  );

  return config;
}

async function provisionSharedPath(
  projectRoot: string,
  projectName: string,
  sharedPath: string
): Promise<void> {
  const localTarget = localSharedFile(projectRoot, sharedPath);
  const globalSource = globalProjectFile(projectName, sharedPath);

  if (await pathExists(globalSource)) {
    await ensureSymlink(localTarget, globalSource, { relative: false, type: "file" });
    logger.step(`🔗 anomaly shared/${sharedPath} → ${logger.dim(globalSource)}`);
    return;
  }

  await ensureDir(path.dirname(localTarget));
  const created = await writeTextIfMissing(localTarget, "");
  if (created) {
    logger.step(`🌱 sprouted shared/${sharedPath} (no anomaly in the global plane)`);
  }
}
