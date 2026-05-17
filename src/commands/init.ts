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
  findProjectRoot,
} from "../core/project.js";
import {
  globalProfileExists,
  loadGlobalConfig,
  saveGlobalConfig,
} from "../core/config.js";
import {
  globalMultiversesDir,
  globalProjectConfig,
  globalProjectDir,
  globalProjectFile,
  globalProjectScriptsDir,
  globalRoot,
  globalSharedDir,
  localConfigFile,
  localRoot,
  localScriptsDir,
  localSharedDir,
  localSharedFile,
  localUniversesDir,
  slotName,
  slotPath,
} from "../core/paths.js";
import { ensureSymlink } from "../core/symlinks.js";
import { run } from "../utils/exec.js";
import {
  materializeTemplateScripts,
  resolveTemplate,
  seedBuiltInDefaultTemplate,
  type ResolvedTemplate,
} from "../core/templates.js";

export interface InitOptions {
  name?: string;
  universes?: number;
  template?: string;
  force?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const projectRoot = await findProjectRoot();

  await ensureGlobalRoot();

  const template = await resolveTemplate(options.template);
  if (template.source === "override") {
    logger.step(`📐 using template ${logger.dim(template.dir ?? "")}`);
  }

  const projectName = options.name ?? deriveProjectName(projectRoot);
  logger.info(
    `🛸 Anchoring ${logger.bold(projectName)} to the Multiverse (${logger.dim(projectRoot)})`
  );

  const existed = await globalProfileExists(projectName);
  const config = await prepareGlobalProfile(projectName, options, existed, template);

  await ensureDir(localRoot(projectRoot));
  await ensureDir(localSharedDir(projectRoot));
  await ensureDir(localUniversesDir(projectRoot));

  await ensureSymlink(
    localConfigFile(projectRoot),
    globalProjectConfig(projectName),
    { relative: false, type: "file" }
  );
  logger.step(`🪢 linked config.json → ${logger.dim(globalProjectConfig(projectName))}`);

  await ensureSymlink(
    localScriptsDir(projectRoot),
    globalProjectScriptsDir(projectName),
    { relative: false, type: "dir" }
  );
  logger.step(`🪢 linked scripts/ → ${logger.dim(globalProjectScriptsDir(projectName))}`);

  for (const sharedPath of config.shared_paths) {
    await provisionSharedPath(projectRoot, projectName, sharedPath);
  }

  for (let i = 1; i <= config.universes_count; i += 1) {
    await ensureDir(slotPath(projectRoot, slotName(i)));
  }
  logger.step(
    `🌌 carved ${config.universes_count} universe slot${config.universes_count === 1 ? "" : "s"}`
  );

  const ignored = await writeTextIfMissing(
    path.join(localRoot(projectRoot), ".gitignore"),
    "*\n"
  );
  if (ignored) {
    logger.step("📝 wrote .worm/.gitignore (self-contained)");
  }

  logger.success(
    existed
      ? `Reused global profile; refreshed Multiverse layout for ${projectName}.`
      : `${projectName} is now bound to the Multiverse.`
  );
  logger.raw("");
  logger.raw(`Inspect with ${logger.bold("worm status")}.`);
}

async function ensureGlobalRoot(): Promise<void> {
  const root = globalRoot();
  // Detect first run by an inner marker rather than the root itself — the root
  // may have been pre-created (sandboxes, tests, mounted volumes).
  const firstRun = !(await pathExists(globalMultiversesDir()));

  await ensureDir(root);
  await ensureDir(globalMultiversesDir());
  await ensureDir(globalSharedDir());
  await seedBuiltInDefaultTemplate();

  const rulesPath = path.join(globalSharedDir(), "global-rules.md");
  await writeTextIfMissing(
    rulesPath,
    "# Global rules\n\nInstructions applied to every wormhole-managed project.\n"
  );

  await writeTextIfMissing(
    path.join(root, "README.md"),
    "# wormhole personal repo\n\nThis directory is managed by the `worm` CLI.\nIt holds per-project profiles (multiverses/), shared rules (shared/), and templates (templates/).\n"
  );

  await initGitRepoIfNeeded(root);

  if (firstRun) {
    logger.info(`🪐 First run — created your Multiverse at ${logger.dim(root)}`);
  }
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

async function prepareGlobalProfile(
  projectName: string,
  options: InitOptions,
  existed: boolean,
  template: ResolvedTemplate
) {
  const projectDir = globalProjectDir(projectName);
  await ensureDir(projectDir);

  let config = existed ? await loadGlobalConfig(projectName) : template.config;
  if (options.universes !== undefined) {
    if (existed && config.universes_count !== options.universes && !options.force) {
      throw new WormError(
        `Profile already exists with universes_count=${config.universes_count}. Refusing to change it.`,
        { hint: "Pass --force to overwrite, or edit the config file manually." }
      );
    }
    config = { ...config, universes_count: options.universes };
  }

  // Only write the config if it doesn't exist yet, or if --force is given.
  // This preserves user edits to ~/.worm/multiverses/<project>/config.json across re-runs.
  const configPath = globalProjectConfig(projectName);
  const configExisted = await pathExists(configPath);
  if (!configExisted || options.force || options.universes !== undefined) {
    await saveGlobalConfig(projectName, config);
  }

  await materializeTemplateScripts(template, globalProjectScriptsDir(projectName));

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
