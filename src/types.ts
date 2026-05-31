import { z } from "zod";

export const HooksSchema = z
  .object({
    // on_create: runs once when a slot is created (`worm universe add`) and on `worm switch`.
    on_create: z.string().optional(),
    // on_remove: runs when a slot is removed (`worm universe rm`).
    on_remove: z.string().optional(),
  })
  .strict();

export const SandboxSchema = z
  .object({
    recipe: z.enum(["none", "docker"]).default("none"),
    // The following only apply when recipe !== "none":
    tools: z.array(z.string()).default([]),
    neverSandbox: z.array(z.string()).default(["node", "npm", "npx", "pnpm", "yarn"]),
    exemptDirs: z.array(z.string()).default([]),
    promptShaping: z.boolean().default(false),
    autostart: z.boolean().default(true),
    autostop: z.boolean().default(false),
  })
  .strict();

export const ConfigSchema = z
  .object({
    // The "wormhole tunnels": files symlinked from each slot back into the Manifest.
    // The pool is emergent — slots are born via `worm universe add <branch>`.
    shared_paths: z.array(z.string().min(1)).default([]),
    hooks: HooksSchema.default({}),
    sandbox: SandboxSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type Hooks = z.infer<typeof HooksSchema>;
export type SandboxConfig = z.infer<typeof SandboxSchema>;

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
