import { z } from "zod";

export const HooksSchema = z
  .object({
    on_warp: z.string().optional(),
    on_collapse: z.string().optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    universes_count: z.number().int().min(1).max(64),
    anchors: z.array(z.string().min(1)).default([]),
    shared_paths: z.array(z.string().min(1)).default([]),
    hooks: HooksSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type Hooks = z.infer<typeof HooksSchema>;

export const DEFAULT_CONFIG: Config = {
  universes_count: 3,
  anchors: [],
  shared_paths: [],
  hooks: {
    on_warp: 'bash "$WORM_PROJECT_ROOT/.worm/scripts/setup.sh"',
  },
};

export type SlotStatus = "STABLE" | "ACTIVE" | "BROKEN";

export interface UniverseSlot {
  name: string;
  slotPath: string;
  srcPath: string;
  status: SlotStatus;
  branch?: string;
  reason?: string;
}

export interface ProjectContext {
  root: string;
  name: string;
  config: Config;
  globalProjectDir: string;
}
