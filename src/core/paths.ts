import os from "node:os";
import path from "node:path";

export const GLOBAL_ROOT_NAME = ".worm";
export const LOCAL_ROOT_NAME = ".worm";
export const SHARED_DIR_NAME = "shared";
export const CONFIG_FILE_NAME = "config.json";
export const MULTIVERSES_DIR_NAME = "multiverses";
export const TEMPLATES_DIR_NAME = "templates";
export const DEFAULT_TEMPLATE_NAME = "default";
export const SCRIPTS_DIR_NAME = "scripts";
export const SANDBOX_DIR_NAME = "sandbox";
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

export function localSandboxDir(projectRoot: string): string {
  return path.join(localRoot(projectRoot), SANDBOX_DIR_NAME);
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
