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
  globalProjectConfig,
  globalProjectDir,
  globalProjectScriptsDir,
  globalProjectsDir,
  globalRoot,
  globalSharedDir,
  localConfigFile,
  localRoot,
  localScriptsDir,
} from "../core/paths.js";
import { ensureSymlink } from "../core/symlinks.js";
import { applyRecipeWiring, materializeRecipes } from "../core/recipes.js";
import { currentBranch, ensureGitExclude } from "../core/git.js";
import { applyEnv } from "../core/env.js";
import { hookEnv, runHook } from "../core/hooks.js";
import { run } from "../utils/exec.js";
import type { UniverseSlot } from "../types.js";
import {
  materializeTemplateScripts,
  resolveTemplate,
  seedBuiltInDefaultTemplate,
  type ResolvedTemplate,
} from "../core/templates.js";
import {
  readManifest,
  reconcileSlotLinks,
  writeManifest,
  planAdoption,
  executeAdoption,
  formatAdoptionMove,
} from "../core/links.js";
import { resolveStoreLinks } from "../core/stores.js";
import { ensureLocalLayout } from "../core/layout.js";

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
 * Bind a normal git clone as Slot 0 of a worm project. Shared between
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
    `🛸 Binding ${logger.bold(projectName)} as Slot 0 (${logger.dim(projectRoot)})`
  );

  const existed = await globalProfileExists(projectName);
  const config = await prepareGlobalProfile(projectName, options, existed, template);

  await ensureDir(localRoot(projectRoot));
  // Durable state (recipes/, logs/, the manifest) lives in the profile; .worm/
  // holds symlinks into it. Migrates an old layout in place.
  await ensureLocalLayout(projectRoot, projectName);

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

  // Reconcile Slot 0's wormhole tunnels (links straight into the profile) and
  // seed the manifest. First, adopt any existing local files into the profile.
  const manifest = await readManifest(projectName);
  const links = await resolveStoreLinks(config, projectName);

  // Plan and execute adoption (move slot-local files into profile, then symlink).
  const adoptionPlan = await planAdoption(projectRoot, links);
  if (adoptionPlan.operations.length > 0) {
    if (adoptionPlan.hasConflicts) {
      const conflicts = adoptionPlan.operations
        .filter((o) => o.type === "conflict")
        .map((o) => `  ${o.tail} — ${o.conflictReason}`)
        .join("\n");
      throw new WormError(
        `Cannot adopt — a real file exists in both Slot 0 and the profile:\n${conflicts}`,
        { hint: "Keep the copy you want (delete the other), then re-run `worm init`." }
      );
    }
    logger.info("🛸 Adopting existing files into the profile:");
    for (const op of adoptionPlan.operations) {
      if (op.type === "move") logger.raw(`  ${formatAdoptionMove(op)}`);
    }
    await executeAdoption(projectRoot, adoptionPlan.operations);
  }

  await reconcileSlotLinks(projectRoot, links, manifest);
  await writeManifest(projectName, manifest);

  // Generate Slot 0's per-worktree env file (no-op unless `env` is configured).
  const slot0Branch = (await currentBranch(projectRoot)) ?? "";
  const envRes = await applyEnv(projectRoot, config, { name: "main", index: 0 }, slot0Branch);
  if (envRes?.written) logger.step(`📝 generated ${envRes.file}`);

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
      env: hookEnv(projectRoot, slot, branch, projectName),
    });
    if (result.ran && result.exitCode !== 0) {
      logger.warn(
        `on_create hook exited with code ${result.exitCode}. Slot 0 is bound but may not be fully warmed.`
      );
    }
  }

  logger.success(
    existed
      ? `Reused profile; refreshed layout for ${projectName} (Slot 0).`
      : `${projectName} is now bound as Slot 0.`
  );
  logger.raw("");
  logger.raw(
    `💡 Your profile lives at ${logger.dim(globalProjectDir(projectName))}`
  );
  logger.raw(
    `   Edit ${logger.bold("config.json")} (shared_paths, hooks, recipes) and ${logger.bold("scripts/setup.sh")} (warm-up commands) there.`
  );
  logger.raw(
    `   Spin up a parallel universe with ${logger.bold("worm universe add <branch>")}; inspect with ${logger.bold("worm status")}.`
  );
}

async function ensureGlobalRoot(): Promise<void> {
  const root = globalRoot();
  await ensureDir(root);

  // Detect first run by an inner marker rather than the root itself — the root
  // may have been pre-created (sandboxes, tests, mounted volumes).
  const firstRun = !(await pathExists(globalProjectsDir()));

  await ensureDir(globalProjectsDir());
  await ensureDir(globalSharedDir());
  await seedBuiltInDefaultTemplate();

  await writeTextIfMissing(
    path.join(globalSharedDir(), "global-rules.md"),
    "# Global rules\n\nInstructions applied to every wormhole-managed project.\n"
  );

  await writeTextIfMissing(
    path.join(root, "README.md"),
    "# wormhole personal repo\n\nThis directory is managed by the `worm` CLI.\nIt holds per-project profiles (projects/), shared rules (shared/), and templates (templates/).\n"
  );

  // Machine-local state must never sync across machines (it holds absolute slot
  // paths / per-host markers) — exclude it so the `autosync` recipe doesn't
  // commit & push it and create cross-machine conflicts on every node. Reconcile
  // (append missing lines) rather than write-if-missing, so a re-run of `init`
  // heals older installs whose .gitignore predates a newly-added entry.
  await ensureGitignoreLines(path.join(root, ".gitignore"), [
    "# Machine-local worm state — not meant to sync across machines.",
    ".managed-links.json",
    ".detached-links.json",
    ".autosync-conflict.json",
    ".autosync-last-push",
    ".sync-global-settings.base.json",
    "projects/*/logs/",
  ]);

  await initGitRepoIfNeeded(root);

  if (firstRun) {
    logger.info(`🪐 First run — created your wormhole at ${logger.dim(root)}`);
  }
}

// Ensure every line in `lines` is present in the .gitignore at `file`, appending
// any that are missing (order-preserving, no duplicates). Idempotent.
async function ensureGitignoreLines(file: string, lines: string[]): Promise<void> {
  let current = "";
  if (await pathExists(file)) current = await fs.readFile(file, "utf8");
  const present = new Set(current.split(/\r?\n/));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? current : current + "\n";
  await fs.writeFile(file, prefix + missing.join("\n") + "\n");
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
  // preserve user edits to ~/.worm/projects/<project>/config.json on re-run.
  const configPath = globalProjectConfig(projectName);
  const configExisted = await pathExists(configPath);
  if (!configExisted || options.force) {
    await saveGlobalConfig(projectName, config);
  }

  await materializeTemplateScripts(template, globalProjectScriptsDir(projectName));

  return config;
}
