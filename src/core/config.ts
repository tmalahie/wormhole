import { ConfigSchema, type Config } from "../types.js";
import { WormError } from "../utils/errors.js";
import { pathExists, readJson, writeJson } from "../utils/fs.js";
import {
  globalProjectConfig,
  globalProjectDir,
  localConfigFile,
} from "./paths.js";

/**
 * Map a pre-Strategy-3 config onto the current schema so old projects keep
 * loading. The schema is `.strict()`, so unknown legacy keys would otherwise
 * hard-fail. We drop `universes_count`/`anchors`/`max_universes` (emergent pool,
 * no anchors, no cap) and rename the lifecycle hooks.
 */
function normalizeLegacyConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete obj.universes_count;
  delete obj.anchors;
  delete obj.max_universes;
  if (obj.hooks && typeof obj.hooks === "object") {
    const hooks: Record<string, unknown> = { ...(obj.hooks as Record<string, unknown>) };
    if (hooks.on_warp !== undefined && hooks.on_create === undefined) {
      hooks.on_create = hooks.on_warp;
    }
    if (hooks.on_collapse !== undefined && hooks.on_remove === undefined) {
      hooks.on_remove = hooks.on_collapse;
    }
    delete hooks.on_warp;
    delete hooks.on_collapse;
    obj.hooks = hooks;
  }
  return obj;
}

export async function loadConfigFromPath(filePath: string): Promise<Config> {
  if (!(await pathExists(filePath))) {
    throw new WormError(`Config file not found: ${filePath}`, {
      hint: "Run `worm init` to set up a profile.",
    });
  }
  const raw = normalizeLegacyConfig(await readJson<unknown>(filePath));
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new WormError(`Invalid config at ${filePath}:\n${issues}`);
  }
  return result.data;
}

export async function loadGlobalProjectConfig(projectName: string): Promise<Config> {
  return loadConfigFromPath(globalProjectConfig(projectName));
}

export async function loadLocalConfig(projectRoot: string): Promise<Config> {
  return loadConfigFromPath(localConfigFile(projectRoot));
}

export async function saveGlobalConfig(
  projectName: string,
  config: Config
): Promise<string> {
  const filePath = globalProjectConfig(projectName);
  await writeJson(filePath, ConfigSchema.parse(config));
  return filePath;
}

export async function globalProfileExists(projectName: string): Promise<boolean> {
  return pathExists(globalProjectDir(projectName));
}
