import { z } from "zod";
import { WormError } from "../utils/errors.js";
import { pathExists, readJson, writeJson } from "../utils/fs.js";
import { globalConfigFile } from "./paths.js";

/**
 * Machine-level worm settings stored in ~/.worm/config.json. Distinct from
 * the per-project `~/.worm/multiverses/<name>/config.json` — this file holds
 * preferences that apply across every project on this machine (currently
 * just the editor used by `worm warp --open`).
 */
export const GlobalConfigSchema = z
  .object({
    editor: z.string().min(1).optional(),
    // HOME-scope shared links: each tail is linked as `~/<tail>` →
    // `~/.worm/shared/<tail>` by `worm sync --global` (so e.g. `~/.claude/commands`
    // points into the personal repo). Edited in this JSON directly — not via
    // `worm config`, which only sets scalar string keys.
    shared_paths: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/** Scalar string keys settable via `worm config <key> <value>` (arrays like
 *  `shared_paths` are edited in the JSON directly). */
export const SUPPORTED_GLOBAL_KEYS = ["editor"] as const;
export type ScalarGlobalKey = (typeof SUPPORTED_GLOBAL_KEYS)[number];

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const filePath = globalConfigFile();
  if (!(await pathExists(filePath))) return {};
  const raw = await readJson<unknown>(filePath);
  const result = GlobalConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new WormError(`Invalid global config at ${filePath}:\n${issues}`);
  }
  return result.data;
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await writeJson(globalConfigFile(), GlobalConfigSchema.parse(config));
}
