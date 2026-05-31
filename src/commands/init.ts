import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import {
  ensureDir,
  fs,
  pathExists,
  writeTextIfMissing,
} from "../utils/fs.js";
import { deriveProjectName, gitToplevel } from "../core/project.js";
import {
  globalProfileExists,
  loadGlobalProjectConfig,
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
} from "../core/paths.js";
import { ensureSymlink } from "../core/symlinks.js";
import { applyRecipeWiring, materializeRecipes } from "../core/recipes.js";
import { currentBranch } from "../core/git.js";
import { hookEnv, runHook } from "../core/hooks.js";
import { run } from "../utils/exec.js";
import type { UniverseSlot } from "../types.js";
import {
  materializeTemplateScripts,
  resolveTemplate,
  seedBuiltInDefaultTemplate,
  type ResolvedTemplate,
} from "../core/templates.js";
import { readManifest, reconcileSlotLinks, writeManifest } from "../core/links.js";

export interface InitOptions {
  name?: string;
  template?: string;
  force?: boolean;
  skipHook?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const root = await gitToplevel(process.cwd());
  if (!root) {
    throw new WormError("Not inside a git repository.", {
      hint: "`git clone` a repo (or cd into one), then run `worm init`. Or use `worm clone <url>`.",
    });
  }
  await bindProject(root, options);
}

/**
 * Bind a normal git clone as Slot 0 of a worm multiverse. Shared between
 * `worm init` (current repo) and `worm clone` (freshly cloned repo).
 */
export async function bindProject(
  projectRoot: string,
  options: InitOptions = {}
): Promise<void> {
  // Canonicalise so every later resolution (git --git-common-dir, scanUniverses,
  // manifest keys) agrees on one path even across /var → /private/var symlinks.
  projectRoot = await fs.realpath(projectRoot);

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

  const ignored = await writeTextIfMissing(
    path.join(localRoot(projectRoot), ".gitignore"),
    "*\n"
  );
  if (ignored) {
    logger.step("📝 wrote .worm/.gitignore (self-contained)");
  }

  // Slot 0 is a real working tree, so git would otherwise see .worm/ as
  // untracked. Exclude it LOCALLY (.git/info/exclude, not the tracked
  // .gitignore) so `git status` stays clean without touching the repo's files.
  await ensureGitExclude(projectRoot, "/.worm/");

  // Reconcile Slot 0's wormhole tunnels and seed the managed-link manifest.
  const manifest = await readManifest(projectRoot);
  await reconcileSlotLinks(projectRoot, projectRoot, config.shared_paths, manifest);
  await writeManifest(projectRoot, manifest);

  // Materialize enabled recipes' artifacts (a no-op when none are enabled).
  const recipeFiles = await materializeRecipes(projectRoot, projectName, config.recipes);
  for (const file of recipeFiles) logger.step(`📦 recipes/${file}`);
  if (await applyRecipeWiring(projectRoot, projectName, { name: "main", path: projectRoot }, config.recipes)) {
    logger.step("⚡ wired recipe hooks for Slot 0");
  }

  // Warm up Slot 0 by firing on_create — `init` is the "create" event for the
  // primary slot. Same contract as `universe add`: non-fatal (the bind succeeds
  // regardless) and skippable via --skip-hook for an already-warm checkout.
  if (!options.skipHook && config.hooks.on_create) {
    const branch = (await currentBranch(projectRoot)) ?? "";
    const slot: UniverseSlot = {
      index: 0,
      name: "main",
      isPrimary: true,
      path: projectRoot,
      status: "READY",
      branch: branch || undefined,
    };
    const result = await runHook("on_create", config.hooks.on_create, {
      cwd: projectRoot,
      env: hookEnv(projectRoot, slot, branch),
    });
    if (result.ran && result.exitCode !== 0) {
      logger.warn(
        `on_create hook exited with code ${result.exitCode}. Slot 0 is bound but may not be fully warmed.`
      );
    }
  }

  logger.success(
    existed
      ? `Reused global profile; refreshed layout for ${projectName}.`
      : `${projectName} is now bound to the Multiverse (Slot 0).`
  );
  logger.raw("");
  logger.raw(
    `Add a parallel universe with ${logger.bold("worm universe add <branch>")}; inspect with ${logger.bold("worm status")}.`
  );
}

async function ensureGitExclude(repoRoot: string, entry: string): Promise<void> {
  const excludePath = path.join(repoRoot, ".git", "info", "exclude");
  try {
    let content = "";
    try {
      content = await fs.readFile(excludePath, "utf8");
    } catch {
      // no existing exclude file
    }
    if (content.split("\n").includes(entry)) return;
    await ensureDir(path.dirname(excludePath));
    const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await fs.writeFile(excludePath, content + sep + entry + "\n", "utf8");
  } catch {
    // Non-fatal: a linked worktree's .git is a file, or perms — skip silently.
  }
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

  await writeTextIfMissing(
    path.join(globalSharedDir(), "global-rules.md"),
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

  const config = existed ? await loadGlobalProjectConfig(projectName) : template.config;

  // Only write the config if it doesn't exist yet, or if --force is given, to
  // preserve user edits to ~/.worm/multiverses/<project>/config.json on re-run.
  const configPath = globalProjectConfig(projectName);
  const configExisted = await pathExists(configPath);
  if (!configExisted || options.force) {
    await saveGlobalConfig(projectName, config);
  }

  await materializeTemplateScripts(template, globalProjectScriptsDir(projectName));

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
