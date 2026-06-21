import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { fs } from "../utils/fs.js";
import { findSlot0Root, gitToplevel, readProjectName } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { currentBranch } from "../core/git.js";
import { scanUniverses } from "../core/universe.js";
import { resolveStoreLinks } from "../core/stores.js";
import {
  liveDetached,
  readDetached,
  readManifest,
  reconcileSlotLinks,
  writeDetached,
  writeManifest,
} from "../core/links.js";
import { applyEnv, assertNoEnvCollision, portOffset } from "../core/env.js";
import { applyRecipeWiring, materializeRecipes } from "../core/recipes.js";
import { ensureLocalLayout } from "../core/layout.js";
import type { UniverseSlot } from "../types.js";

/**
 * `worm wire [path]` — apply the cognitive layer (shared-path tunnels, the
 * per-worktree env file, and recipe hooks) to a worktree worm did NOT create.
 *
 * This is the seam that lets worm compose with other worktree managers
 * (Conductor, worktrunk, plain `git worktree`, Claude Code's native worktrees):
 * call `worm wire .` from their on-create hook and the worktree gets the same
 * config as a managed slot, without worm owning the topology. It reuses the exact
 * core primitives `sync`/`universe add` use, just against an arbitrary path.
 *
 * The target must be a worktree of a worm-bound repo (so `findSlot0Root` resolves
 * Slot 0 and its profile). Idempotent. Never clobbers real files (the reconcile
 * deref-guard skips them), so it's safe to re-run.
 */
export async function runWire(pathArg?: string): Promise<void> {
  const start = pathArg ? path.resolve(pathArg) : process.cwd();
  const top = await gitToplevel(start);
  if (!top) {
    throw new WormError(`Not inside a git worktree (looked at ${start}).`, {
      hint: "Pass a path inside a git worktree, e.g. `worm wire /path/to/worktree`.",
    });
  }
  const worktreeRoot = await fs.realpath(top);

  const slot0Root = await findSlot0Root(worktreeRoot);
  const projectName = await readProjectName(slot0Root);
  const config = await loadLocalConfig(slot0Root);
  assertNoEnvCollision(config);
  await ensureLocalLayout(slot0Root, projectName);

  const branch = (await currentBranch(worktreeRoot)) ?? "";
  const slot = await identifySlot(slot0Root, worktreeRoot, branch);

  logger.info(
    `🔗 Wiring ${logger.bold(slot.name)} on ${logger.bold(branch || "(detached)")} (${logger.dim(worktreeRoot)})`
  );

  const manifest = await readManifest(projectName);
  const allLinks = await resolveStoreLinks(config, projectName);
  // Respect any tails the user detached in this worktree (self-healing).
  const detached = await readDetached(projectName);
  const detachedTails = await liveDetached(worktreeRoot, detached);
  await writeDetached(projectName, detached);
  const links = detachedTails.length > 0
    ? allLinks.filter((l) => !detachedTails.includes(l.tail))
    : allLinks;
  const res = await reconcileSlotLinks(worktreeRoot, links, manifest);
  await writeManifest(projectName, manifest);
  for (const rel of res.created) logger.step(`🔗 linked ${rel}`);
  for (const rel of res.pruned) logger.step(`🧹 pruned ${rel}`);
  for (const rel of res.skipped) {
    logger.warn(`${rel} is a real file, not a managed link — left as-is.`);
  }
  for (const rel of res.missing) {
    logger.warn(`${rel} — store source not found yet; not linked.`);
  }

  const envRes = await applyEnv(worktreeRoot, config, slot, branch);
  if (envRes?.written) logger.step(`📝 generated ${envRes.file}`);

  // Materialize recipe artifacts (idempotent) and wire this worktree's hooks.
  await materializeRecipes(slot0Root, projectName, config.recipes);
  if (await applyRecipeWiring(slot0Root, projectName, { name: slot.name, path: worktreeRoot }, config.recipes)) {
    logger.step("⚡ wired recipe hooks");
  }

  logger.success(`Wired ${slot.name} into ${projectName}'s cognitive layer.`);
}

/**
 * Identify the worktree as a slot. A managed slot (Slot 0 or a `<base>-<N>`
 * sibling) keeps its real index; an externally-created worktree (e.g. Conductor)
 * gets a synthetic slot whose `index` falls back to the branch's stable offset —
 * so `{{ index }}` stays distinct per branch even with no positional slot (prefer
 * `{{ offset }}` there for clarity).
 */
async function identifySlot(
  slot0Root: string,
  worktreeRoot: string,
  branch: string
): Promise<UniverseSlot> {
  const found = (await scanUniverses(slot0Root)).find(
    (s) => path.resolve(s.path) === worktreeRoot
  );
  if (found) return found;
  return {
    index: portOffset(branch),
    name: path.basename(worktreeRoot),
    isPrimary: false,
    path: worktreeRoot,
    status: "READY",
    branch: branch || undefined,
  };
}
