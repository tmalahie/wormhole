import path from "node:path";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../types.js";
import { WormError } from "../utils/errors.js";
import {
  ensureDir,
  fs,
  pathExists,
  readJson,
  writeJson,
  writeTextIfMissing,
} from "../utils/fs.js";
import {
  CONFIG_FILE_NAME,
  SCRIPTS_DIR_NAME,
  SETUP_SCRIPT_NAME,
  globalDefaultTemplateDir,
} from "./paths.js";

export const DEFAULT_SETUP_SCRIPT = `#!/usr/bin/env bash
# Warm-up hook (on_create). Runs from inside a slot's worktree when it is
# created via \`worm universe add\` and on \`worm switch\`.
# Add your install/setup commands here, for example:
#   npm install
#   pip install -r requirements.txt
#   bundle install
#
# Env: $WORM_PROJECT_ROOT, $WORM_SLOT, $WORM_SLOT_INDEX (0-based), $WORM_BRANCH, $WORM_WORKTREE
`;

export interface ResolvedTemplate {
  source: "override" | "global-default" | "builtin";
  /** Path to the template directory on disk, or null when falling back to the built-in defaults. */
  dir: string | null;
  config: Config;
}

/**
 * Seed `~/.worm/templates/default/` with the built-in defaults if it doesn't exist yet.
 * Idempotent — existing files are not overwritten.
 */
export async function seedBuiltInDefaultTemplate(): Promise<void> {
  const dir = globalDefaultTemplateDir();
  await ensureDir(dir);

  const configPath = path.join(dir, CONFIG_FILE_NAME);
  if (!(await pathExists(configPath))) {
    await writeJson(configPath, DEFAULT_CONFIG);
  }

  const scriptsDir = path.join(dir, SCRIPTS_DIR_NAME);
  await ensureDir(scriptsDir);
  const setupPath = path.join(scriptsDir, SETUP_SCRIPT_NAME);
  const created = await writeTextIfMissing(setupPath, DEFAULT_SETUP_SCRIPT);
  if (created) await fs.chmod(setupPath, 0o755);
}

/**
 * Resolve which template to use. Order: explicit override > global default > built-in.
 * Throws WormError if `override` is supplied but invalid.
 */
export async function resolveTemplate(override?: string): Promise<ResolvedTemplate> {
  if (override) {
    const dir = path.resolve(override);
    if (!(await pathExists(dir))) {
      throw new WormError(`Template directory not found: ${dir}`, {
        hint: "Pass --template with a path that exists, or omit the flag to use the global default.",
      });
    }
    const config = await readTemplateConfig(dir);
    return { source: "override", dir, config };
  }

  const globalDir = globalDefaultTemplateDir();
  if (await pathExists(path.join(globalDir, CONFIG_FILE_NAME))) {
    const config = await readTemplateConfig(globalDir);
    return { source: "global-default", dir: globalDir, config };
  }

  return { source: "builtin", dir: null, config: ConfigSchema.parse(DEFAULT_CONFIG) };
}

async function readTemplateConfig(templateDir: string): Promise<Config> {
  const configPath = path.join(templateDir, CONFIG_FILE_NAME);
  if (!(await pathExists(configPath))) {
    throw new WormError(
      `Template at ${templateDir} is missing ${CONFIG_FILE_NAME}.`,
      { hint: "Add a config.json to the template directory, or use a different template." }
    );
  }
  const raw = await readJson<unknown>(configPath);
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new WormError(`Invalid template config at ${configPath}:\n${issues}`);
  }
  return result.data;
}

/**
 * Copy the template's scripts/ directory into `destScriptsDir`.
 * Existing files in the destination are left intact (idempotent).
 * If the template has no scripts/ dir, falls back to seeding a default setup.sh.
 */
export async function materializeTemplateScripts(
  template: ResolvedTemplate,
  destScriptsDir: string
): Promise<void> {
  await ensureDir(destScriptsDir);

  const sourceDir = template.dir ? path.join(template.dir, SCRIPTS_DIR_NAME) : null;
  if (sourceDir && (await pathExists(sourceDir))) {
    await copyDirIfMissing(sourceDir, destScriptsDir);
    return;
  }

  // No scripts/ in the resolved template — drop a default setup.sh so the default hook works.
  const setupPath = path.join(destScriptsDir, SETUP_SCRIPT_NAME);
  const created = await writeTextIfMissing(setupPath, DEFAULT_SETUP_SCRIPT);
  if (created) await fs.chmod(setupPath, 0o755);
}

async function copyDirIfMissing(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await ensureDir(to);
      await copyDirIfMissing(from, to);
    } else if (entry.isFile()) {
      if (await pathExists(to)) continue;
      await fs.copyFile(from, to);
      const stat = await fs.stat(from);
      await fs.chmod(to, stat.mode);
    }
  }
}
