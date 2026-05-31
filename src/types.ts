import { z } from "zod";

export const HooksSchema = z
  .object({
    // on_create: runs once when a slot is created (`worm universe add`) and on `worm switch`.
    on_create: z.string().optional(),
    // on_remove: runs when a slot is removed (`worm universe rm`).
    on_remove: z.string().optional(),
  })
  .strict();

// --- Recipes: composable capabilities, keyed by name (provider-style). A
// recipe is ENABLED iff its key is present in `recipes`; each value is validated
// by that recipe's own schema. The engine in `core/recipes.ts` iterates the
// enabled set to materialize artifacts and wire each slot's settings.local.json.

export const SandboxRecipeSchema = z
  .object({
    backend: z.enum(["docker"]).default("docker"),
    image: z.string().default("node:22-bookworm"),
    tools: z.array(z.string()).default([]),
    neverSandbox: z.array(z.string()).default(["node", "npm", "npx", "pnpm", "yarn"]),
    exemptDirs: z.array(z.string()).default([]),
    autostart: z.boolean().default(true),
    autostop: z.boolean().default(false),
  })
  .strict();

// syncPermissions / shareHistory have no options yet — presence is the signal.
export const SyncPermissionsRecipeSchema = z.object({}).strict();
export const ShareHistoryRecipeSchema = z.object({}).strict();

export const RecipesSchema = z
  .object({
    sandbox: SandboxRecipeSchema.optional(),
    syncPermissions: SyncPermissionsRecipeSchema.optional(),
    shareHistory: ShareHistoryRecipeSchema.optional(),
  })
  .strict()
  .default({});

export const ConfigSchema = z
  .object({
    // The "wormhole tunnels": files symlinked from each slot back into the Manifest.
    // The pool is emergent — slots are born via `worm universe add <branch>`.
    shared_paths: z.array(z.string().min(1)).default([]),
    hooks: HooksSchema.default({}),
    recipes: RecipesSchema,
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type Hooks = z.infer<typeof HooksSchema>;
export type RecipesConfig = z.infer<typeof RecipesSchema>;
export type SandboxRecipeConfig = z.infer<typeof SandboxRecipeSchema>;
export type SyncPermissionsRecipeConfig = z.infer<typeof SyncPermissionsRecipeSchema>;
export type ShareHistoryRecipeConfig = z.infer<typeof ShareHistoryRecipeSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  hooks: { on_create: 'bash "$WORM_PROJECT_ROOT/.worm/scripts/setup.sh"' },
});

export type SlotStatus = "READY" | "BROKEN";

export interface UniverseSlot {
  /** 0 = Slot 0 (the primary working tree). 1.. = sibling pool worktrees. */
  index: number;
  /** "main" for Slot 0, "uni-N" for siblings. */
  name: string;
  isPrimary: boolean;
  /** Absolute path to the worktree directory. */
  path: string;
  status: SlotStatus;
  branch?: string;
  detached?: boolean;
  reason?: string;
}

export interface ProjectContext {
  root: string;
  name: string;
  config: Config;
}
