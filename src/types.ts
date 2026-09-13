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

// The key set a sync recipe tracks: an explicit list, or `"*"` for "every
// top-level key". `"*"` may also appear INSIDE the list, which is how you re-add
// a key the wildcard excludes by default (`["*", "env"]`).
export const SyncKeysSchema = z.union([z.literal("*"), z.array(z.string())]);

// `keys` — the top-level settings.local.json keys kept in step across the
// project's slots. Defaults to `["permissions"]`; `"*"` syncs every key (see
// SyncGlobalPermissionsRecipeSchema for the wildcard's rules). Unlike the global
// recipe there is no auto mode: a slot's settings.local.json is mostly
// worm-generated territory, so widening it is a deliberate act. `hooks` may be
// named — only the USER's own entries sync, worm's dispatch entries are filtered.
export const SyncPermissionsRecipeSchema = z
  .object({ keys: SyncKeysSchema.optional() })
  .strict();
export const ShareHistoryRecipeSchema = z.object({}).strict();
export const ShareMemoryRecipeSchema = z.object({}).strict();
// GLOBAL-scope (like autosync), declared in ~/.worm/config.json:
// `notifyPendingInput` — OS notification when input from you is pending (a
//   finished response to read, or a permission to approve). `openOnClick` is the
//   macOS app the notification click opens the project folder in (any `open -a`
//   app name: "Visual Studio Code", "Cursor", "Windsurf", …). Defaults to "" → no
//   click action (we don't presume an editor); set it to opt into click-to-focus.
// `syncGlobalPermissions` — version-control the global ~/.claude permissions block.
export const NotifyPendingInputRecipeSchema = z
  .object({ openOnClick: z.string().default("") })
  .strict();
// `keys` — the top-level ~/.claude/settings.json keys kept in step with the
// git-tracked canonical copy. Omit for AUTO mode: permissions + sandbox + every
// top-level primitive-valued key (strings/numbers/booleans like effortLevel/tui).
// Set it to pin an explicit list instead — the merge is recursive, so structural
// keys (autoMode, extraKnownMarketplaces, hooks, …) merge per leaf and are safe
// to name. They stay OUT of auto mode because whether they SHOULD follow you to
// another machine is a judgement call, not because the merge can't handle them.
// `"*"` takes that judgement in one go: every key syncs EXCEPT a small denylist
// the worker owns (`env`, which is where an API key would live, and
// `trustedDirectories`, which records a per-machine "I vetted this checkout"
// decision). Name one of those alongside the wildcard (`["*", "env"]`) to opt it
// back in. A wildcard also means keys Claude Code adds in FUTURE versions start
// syncing on their own — that's the trade you're making by choosing it.
// `hooks` is special-cased in the worker: only the user's own entries sync — the
// `worm hook trigger …` entries are worm's, re-wired per machine by
// `worm sync --global`, and never leave it.
export const SyncGlobalPermissionsRecipeSchema = z
  .object({ keys: SyncKeysSchema.optional() })
  .strict();

// autosync is a GLOBAL-scope recipe (the others are project-scope): declared in
// the GLOBAL ~/.worm/config.json `recipes` block and wired by `worm sync --global`
// into ~/.claude/settings.json, it keeps the whole ~/.worm meta-repo synced across
// machines — pull on session start, push (debounced) on stop, flush on session
// end. Conflicts are NEVER auto-resolved: a clean rebase --abort, a durable marker
// surfaced by `worm status`, and an OS notification. No-ops without a git remote.
export const AutosyncSchema = z
  .object({
    remote: z.string().default("origin"),
    debounceMinutes: z.number().nonnegative().default(5),
    notify: z.boolean().default(true),
  })
  .strict();

export const RecipesSchema = z
  .object({
    sandbox: SandboxRecipeSchema.optional(),
    syncPermissions: SyncPermissionsRecipeSchema.optional(),
    shareHistory: ShareHistoryRecipeSchema.optional(),
    shareMemory: ShareMemoryRecipeSchema.optional(),
    autosync: AutosyncSchema.optional(),
    notifyPendingInput: NotifyPendingInputRecipeSchema.optional(),
    syncGlobalPermissions: SyncGlobalPermissionsRecipeSchema.optional(),
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
// A tail ending in `/*` is a directory glob: each CHILD of that store dir is
// linked individually, leaving the parent dir real in the slot (see stores.ts).
export const SharedPathSchema = z.union([
  z.string().min(1),
  z.object({ path: z.string().min(1), store: z.string().min(1).optional() }).strict(),
]);

// Per-worktree environment file. Unlike `shared_paths` (one source symlinked
// everywhere — IDENTICAL content), `env` generates a DIFFERENT dotenv file per
// worktree, with values derived from a STABLE hash of the branch (so a given
// branch always gets the same port/offset, even with ephemeral worktrees).
// `file` is the generated filename (gitignored automatically); `vars` values are
// integer arithmetic over `index` (slot number — positional), `offset`/`hash`
// (branch-stable), plus the text vars `slot` / `branch` — e.g.
// `{{ 3000 + index * 10000 }}` or `{{ 8080 + offset }}`. Templates remain for
// advanced cases; this is the zero-file-to-maintain path for the common one.
export const EnvSchema = z
  .object({
    file: z.string().min(1).default(".env.worm"),
    vars: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const ConfigSchema = z
  .object({
    // The "wormhole tunnels": files symlinked from each slot back into a store
    // (the profile by default). The pool is emergent — slots are born via
    // `worm universe add <branch>`.
    shared_paths: z.array(SharedPathSchema).default([]),
    // Named external stores referenceable by `shared_paths` (project stores
    // override same-named global ones in ~/.worm/config.json).
    stores: z.record(z.string(), StoreSchema).default({}),
    // Optional per-worktree env file (absent → feature off). See EnvSchema.
    env: EnvSchema.optional(),
    hooks: HooksSchema.default({}),
    recipes: RecipesSchema,
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type EnvConfig = z.infer<typeof EnvSchema>;
export type StoreConfig = z.infer<typeof StoreSchema>;
export type SharedPathConfig = z.infer<typeof SharedPathSchema>;
export type Hooks = z.infer<typeof HooksSchema>;
export type RecipesConfig = z.infer<typeof RecipesSchema>;
export type SandboxRecipeConfig = z.infer<typeof SandboxRecipeSchema>;
export type SyncPermissionsRecipeConfig = z.infer<typeof SyncPermissionsRecipeSchema>;
export type ShareHistoryRecipeConfig = z.infer<typeof ShareHistoryRecipeSchema>;
export type ShareMemoryRecipeConfig = z.infer<typeof ShareMemoryRecipeSchema>;
export type AutosyncConfig = z.infer<typeof AutosyncSchema>;
export type NotifyPendingInputRecipeConfig = z.infer<typeof NotifyPendingInputRecipeSchema>;
export type SyncGlobalPermissionsRecipeConfig = z.infer<typeof SyncGlobalPermissionsRecipeSchema>;

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
