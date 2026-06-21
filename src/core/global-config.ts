import { z } from "zod";
import { WormError } from "../utils/errors.js";
import { pathExists, readJson, writeJson } from "../utils/fs.js";
import { globalConfigFile } from "./paths.js";
import { RecipesSchema, StoreSchema } from "../types.js";

/**
 * Machine-level worm settings stored in ~/.worm/config.json. Distinct from
 * the per-project `~/.worm/projects/<name>/config.json` — this file holds
 * HOME-scope `shared_paths`, machine-wide `stores`, and global `recipes`. Edited
 * as JSON directly (no `worm config` scalar command).
 */
export const GlobalConfigSchema = z
  .object({
    // HOME-scope shared links: each tail is linked as `~/<tail>` →
    // `~/.worm/shared/<tail>` by `worm sync --global` (so e.g. `~/.claude/commands`
    // points into the personal repo).
    shared_paths: z.array(z.string().min(1)).optional(),
    // Machine-wide named stores any project's `shared_paths` can pull from.
    stores: z.record(z.string(), StoreSchema).optional(),
    // Machine-wide recipes (only GLOBAL-scope ones take effect here). `worm sync
    // --global` wires them into ~/.claude/settings.json.
    recipes: RecipesSchema.optional(),
  })
  .strict();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

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
