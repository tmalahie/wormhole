import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GLOBAL_ROOT_NAME = ".worm";
export const LOCAL_ROOT_NAME = ".worm";
export const SHARED_DIR_NAME = "shared";
export const CONFIG_FILE_NAME = "config.json";
export const MULTIVERSES_DIR_NAME = "multiverses";
export const TEMPLATES_DIR_NAME = "templates";
export const DEFAULT_TEMPLATE_NAME = "default";
export const SCRIPTS_DIR_NAME = "scripts";
export const RECIPES_DIR_NAME = "recipes";
export const LOGS_DIR_NAME = "logs";
export const SETUP_SCRIPT_NAME = "setup.sh";
export const MANAGED_LINKS_FILE_NAME = ".managed-links.json";
/** Joins the repo basename and slot index for sibling worktree dirs: `<repo>-<N>`. */
export const SLOT_DIR_INFIX = "-";

export function globalRoot(): string {
  const override = process.env.WORM_HOME;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), GLOBAL_ROOT_NAME);
}

export function globalMultiversesDir(): string {
  return path.join(globalRoot(), MULTIVERSES_DIR_NAME);
}

export function globalSharedDir(): string {
  return path.join(globalRoot(), SHARED_DIR_NAME);
}

export function globalConfigFile(): string {
  return path.join(globalRoot(), CONFIG_FILE_NAME);
}

export function globalProjectDir(projectName: string): string {
  return path.join(globalMultiversesDir(), projectName);
}

export function globalProjectConfig(projectName: string): string {
  return path.join(globalProjectDir(projectName), CONFIG_FILE_NAME);
}

export function globalProjectFile(projectName: string, fileName: string): string {
  return path.join(globalProjectDir(projectName), fileName);
}

export function globalProjectScriptsDir(projectName: string): string {
  return path.join(globalProjectDir(projectName), SCRIPTS_DIR_NAME);
}

export function globalTemplatesDir(): string {
  return path.join(globalRoot(), TEMPLATES_DIR_NAME);
}

export function globalDefaultTemplateDir(): string {
  return path.join(globalTemplatesDir(), DEFAULT_TEMPLATE_NAME);
}

export function localRoot(projectRoot: string): string {
  return path.join(projectRoot, LOCAL_ROOT_NAME);
}

export function localConfigFile(projectRoot: string): string {
  return path.join(localRoot(projectRoot), CONFIG_FILE_NAME);
}

export function localSharedDir(projectRoot: string): string {
  return path.join(localRoot(projectRoot), SHARED_DIR_NAME);
}

export function localSharedFile(projectRoot: string, fileName: string): string {
  return path.join(localSharedDir(projectRoot), fileName);
}

export function localScriptsDir(projectRoot: string): string {
  return path.join(localRoot(projectRoot), SCRIPTS_DIR_NAME);
}

/** Root for all recipe artifacts: `.worm/recipes/`. */
export function localRecipesRoot(projectRoot: string): string {
  return path.join(localRoot(projectRoot), RECIPES_DIR_NAME);
}

/** A single recipe's artifact dir: `.worm/recipes/<name>/`. */
export function localRecipeDir(projectRoot: string, recipeName: string): string {
  return path.join(localRecipesRoot(projectRoot), recipeName);
}

/**
 * Root of the worm-OWNED recipe code that ships WITH the binary — the
 * config-independent scripts (the sandbox interceptor, the permission-sync
 * script) that are parameterized at run time and so live ONCE rather than being
 * copied per project. tsup copies `src/recipes/` → `dist/recipes/` at build; at
 * run time the bundle is `dist/cli.js`, so `import.meta.url` resolves to `dist/`
 * and the scripts sit alongside at `dist/recipes/`.
 */
export function packagedRecipesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), RECIPES_DIR_NAME);
}

/** A single packaged recipe code file: `dist/recipes/<name>/<file>`. */
export function packagedRecipeScript(recipeName: string, file: string): string {
  return path.join(packagedRecipesDir(), recipeName, file);
}

/** Where recipe hooks write their logs: `.worm/logs/` (at Slot 0). */
export function localLogsDir(slot0Root: string): string {
  return path.join(localRoot(slot0Root), LOGS_DIR_NAME);
}

/**
 * Path to the managed-link manifest at Slot 0 (.worm/.managed-links.json).
 * `worm sync` records the symlinks it creates here so prune/GC only ever
 * touches links it owns — never structural wiring or real user files.
 */
export function managedLinksFile(slot0Root: string): string {
  return path.join(localRoot(slot0Root), MANAGED_LINKS_FILE_NAME);
}

/**
 * Directory of a sibling pool worktree. Slot 0 IS the primary working tree
 * (slot0Root itself); extra slots are TRUE siblings one level up:
 *   <parent>/<project>-uni<index>   e.g. ~/git/my-project-uni1
 * Placing them outside slot 0 keeps git from seeing them as untracked dirs.
 */
export function siblingWorktreeDir(slot0Root: string, index: number): string {
  const parent = path.dirname(slot0Root);
  const base = path.basename(slot0Root);
  return path.join(parent, `${base}${SLOT_DIR_INFIX}${index}`);
}
