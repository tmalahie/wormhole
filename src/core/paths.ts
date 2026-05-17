import os from "node:os";
import path from "node:path";

export const GLOBAL_ROOT_NAME = ".worm";
export const LOCAL_ROOT_NAME = ".worm";
export const SHARED_DIR_NAME = "shared";
export const UNIVERSES_DIR_NAME = "universes";
export const WORKTREE_SRC_NAME = "src";
export const CONFIG_FILE_NAME = "config.json";
export const MULTIVERSES_DIR_NAME = "multiverses";
export const TEMPLATES_DIR_NAME = "templates";
export const DEFAULT_TEMPLATE_NAME = "default";
export const SCRIPTS_DIR_NAME = "scripts";
export const SETUP_SCRIPT_NAME = "setup.sh";
export const SLOT_PREFIX = "uni-";

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

export function globalProjectDir(projectName: string): string {
  return path.join(globalMultiversesDir(), projectName);
}

export function globalProjectConfig(projectName: string): string {
  return path.join(globalProjectDir(projectName), CONFIG_FILE_NAME);
}

export function globalProjectFile(projectName: string, fileName: string): string {
  return path.join(globalProjectDir(projectName), fileName);
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

export function localUniversesDir(projectRoot: string): string {
  return path.join(localRoot(projectRoot), UNIVERSES_DIR_NAME);
}

export function localScriptsDir(projectRoot: string): string {
  return path.join(localRoot(projectRoot), SCRIPTS_DIR_NAME);
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

export function slotName(index: number): string {
  return `${SLOT_PREFIX}${index}`;
}

export function slotIndex(slot: string): number {
  return Number.parseInt(slot.slice(SLOT_PREFIX.length), 10);
}

export function slotPath(projectRoot: string, slot: string): string {
  return path.join(localUniversesDir(projectRoot), slot);
}

export function slotSrcPath(projectRoot: string, slot: string): string {
  return path.join(slotPath(projectRoot, slot), WORKTREE_SRC_NAME);
}

export function slotAnchorPath(
  projectRoot: string,
  slot: string,
  anchor: string
): string {
  return path.join(slotPath(projectRoot, slot), anchor);
}
