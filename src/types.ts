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
    // node is intentionally NOT exempt: `node <script>` runs arbitrary code, so
    // it's sandboxed (see the interceptor). npm/npx/pnpm/yarn stay exempt — they
    // rely on host-built native node_modules.
    neverSandbox: z.array(z.string()).default(["npm", "npx", "pnpm", "yarn"]),
    exemptDirs: z.array(z.string()).default([]),
    autostart: z.boolean().default(true),
    autostop: z.boolean().default(false),
  })
  .strict();

// syncPermissions / shareHistory / shareMemory have no options yet — presence is the signal.
export const SyncPermissionsRecipeSchema = z.object({}).strict();
export const ShareHistoryRecipeSchema = z.object({}).strict();
export const ShareMemoryRecipeSchema = z.object({}).strict();

export const RecipesSchema = z
  .object({
    sandbox: SandboxRecipeSchema.optional(),
    syncPermissions: SyncPermissionsRecipeSchema.optional(),
    shareHistory: ShareHistoryRecipeSchema.optional(),
    shareMemory: ShareMemoryRecipeSchema.optional(),
  })
  .strict()
  .default({});

// A "store" is a source of shared files. A shared_path with no `store` comes
// from the project PROFILE (the default store); one with a `store` comes from
// that named store's root. `url` lets worm clone the store on demand if its
// `root` is missing — so e.g. team docs can live in a separate git repo.
export const StoreSchema = z
  .object({
    root: z.string().min(1),
    url: z.string().min(1).optional(),
  })
  .strict();

// A shared_path is either a bare tail (profile store) or `{ path, store }`
// pulling that tail from a named store. `store` is optional → defaults to profile.
export const SharedPathSchema = z.union([
  z.string().min(1),
  z.object({ path: z.string().min(1), store: z.string().min(1).optional() }).strict(),
]);

export const ConfigSchema = z
  .object({
    // The "wormhole tunnels": files symlinked from each slot back into a store
    // (the profile by default). The pool is emergent — slots are born via
    // `worm universe add <branch>`.
    shared_paths: z.array(SharedPathSchema).default([]),
    // Named external stores referenceable by `shared_paths` (project stores
    // override same-named global ones in ~/.worm/config.json).
    stores: z.record(z.string(), StoreSchema).default({}),
    hooks: HooksSchema.default({}),
    recipes: RecipesSchema,
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type StoreConfig = z.infer<typeof StoreSchema>;
export type SharedPathConfig = z.infer<typeof SharedPathSchema>;
export type Hooks = z.infer<typeof HooksSchema>;
export type RecipesConfig = z.infer<typeof RecipesSchema>;
export type SandboxRecipeConfig = z.infer<typeof SandboxRecipeSchema>;
export type SyncPermissionsRecipeConfig = z.infer<typeof SyncPermissionsRecipeSchema>;
export type ShareHistoryRecipeConfig = z.infer<typeof ShareHistoryRecipeSchema>;
export type ShareMemoryRecipeConfig = z.infer<typeof ShareMemoryRecipeSchema>;

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
