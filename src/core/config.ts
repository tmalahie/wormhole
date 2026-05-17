import { ConfigSchema, type Config } from "../types.js";
import { WormError } from "../utils/errors.js";
import { pathExists, readJson, writeJson } from "../utils/fs.js";
import {
  globalProjectConfig,
  globalProjectDir,
  localConfigFile,
} from "./paths.js";

export async function loadConfigFromPath(filePath: string): Promise<Config> {
  if (!(await pathExists(filePath))) {
    throw new WormError(`Config file not found: ${filePath}`, {
      hint: "Run `worm init` and `worm register` to set up a profile.",
    });
  }
  const raw = await readJson<unknown>(filePath);
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new WormError(`Invalid config at ${filePath}:\n${issues}`);
  }
  return result.data;
}

export async function loadGlobalConfig(projectName: string): Promise<Config> {
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
