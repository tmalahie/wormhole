import path from "node:path";
import { logger } from "../utils/logger.js";
import { findSlot0Root, readProjectName } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { scanUniverses } from "../core/universe.js";
import {
  readManifest,
  reconcileSlotLinks,
  writeManifest,
} from "../core/links.js";
import { applyRecipeWiring, materializeRecipes } from "../core/recipes.js";
import { resolveStoreLinks } from "../core/stores.js";
import { ensureLocalLayout, removeLegacyShared } from "../core/layout.js";
import { loadGlobalConfig } from "../core/global-config.js";
import {
  reconcileGlobalLinks,
  readGlobalManifest,
  writeGlobalManifest,
} from "../core/global-links.js";

export interface SyncOptions {
  /** Reconcile HOME-scope shared links (~/.worm/config.json) instead of a project. */
  global?: boolean;
}

/**
 * Declarative reconciliation of the cognitive layer across every existing slot:
 * ensures each slot's wormhole tunnels (shared_paths) match the config, prunes
 * managed links that are no longer declared, and drops manifest entries for
 * slots that no longer exist. Idempotent. Does NOT create or remove slots.
 *
 * With `--global`, reconciles the HOME scope instead: `~/<tail>` →
 * `~/.worm/shared/<tail>` for each tail in the global config's `shared_paths`.
 */
export async function runSync(options: SyncOptions = {}): Promise<void> {
  if (options.global) {
    await runGlobalSync();
    return;
  }
  const root = await findSlot0Root();
  const config = await loadLocalConfig(root);
  const projectName = await readProjectName(root);
  // Ensure the consolidated layout (recipes/logs symlinks into the profile,
  // manifest in the profile); migrates an old project in place.
  await ensureLocalLayout(root, projectName);
  const slots = await scanUniverses(root);
  const manifest = await readManifest(projectName);
  // Resolve shared_paths to concrete sources once (clones any missing store).
  const links = await resolveStoreLinks(config, projectName);

  let created = 0;
  let pruned = 0;
  for (const slot of slots) {
    const res = await reconcileSlotLinks(slot.path, links, manifest);
    created += res.created.length;
    pruned += res.pruned.length;
    for (const rel of res.created) logger.step(`🔗 ${slot.name}: linked ${rel}`);
    for (const rel of res.pruned) logger.step(`🧹 ${slot.name}: pruned ${rel}`);
    for (const rel of res.skipped) {
      logger.warn(`${slot.name}: ${rel} is a real file, not a managed link — left as-is.`);
    }
    for (const rel of res.missing) {
      logger.warn(`${slot.name}: ${rel} — store source not found yet; not linked.`);
    }
  }

  // Garbage-collect manifest entries for slots that no longer exist.
  const live = new Set(slots.map((s) => path.resolve(s.path)));
  for (const key of Object.keys(manifest)) {
    if (!live.has(key)) delete manifest[key];
  }
  await writeManifest(projectName, manifest);
  await removeLegacyShared(root); // sweep any stale .worm/shared after re-pointing

  // Materialize enabled recipes' artifacts (a no-op when none enabled; non-clobbering).
  const recipeFiles = await materializeRecipes(root, projectName, config.recipes);
  for (const file of recipeFiles) logger.step(`📦 recipes/${file}`);
  const anyEnabled = Object.keys(config.recipes).length > 0;
  for (const slot of slots) {
    if (await applyRecipeWiring(root, projectName, slot, config.recipes)) {
      logger.step(`⚡ ${slot.name}: recipe hooks ${anyEnabled ? "wired" : "removed"}`);
    }
  }

  logger.success(
    `Synced ${slots.length} universe${slots.length === 1 ? "" : "s"} — ${created} linked, ${pruned} pruned.`
  );
}

/**
 * Reconcile HOME-scope shared links from the global config. Independent of any
 * project — never resolves Slot 0. Idempotent; does not provision `~/.worm`
 * (if there's nothing configured and no prior state, it's a no-op with a hint).
 */
async function runGlobalSync(): Promise<void> {
  const config = await loadGlobalConfig();
  const desired = config.shared_paths ?? [];
  const manifest = await readGlobalManifest();

  if (desired.length === 0 && Object.keys(manifest).length === 0) {
    logger.info("🪐 No global shared_paths configured in ~/.worm/config.json.");
    logger.hint(
      'Add e.g. "shared_paths": [".claude/commands", ".claude/skills"] there, then re-run `worm sync --global`.'
    );
    return;
  }

  const res = await reconcileGlobalLinks(desired, manifest);
  await writeGlobalManifest(manifest);

  for (const rel of res.created) logger.step(`🔗 linked ~/${rel} → shared/${rel}`);
  for (const rel of res.pruned) logger.step(`🧹 pruned ~/${rel}`);
  for (const rel of res.skipped) {
    logger.warn(`~/${rel} is a real path, not a managed link — left as-is.`);
  }
  logger.success(`🪐 Global sync — ${res.created.length} linked, ${res.pruned.length} pruned.`);
}
