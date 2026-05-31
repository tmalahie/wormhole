import path from "node:path";
import { logger } from "../utils/logger.js";
import { findSlot0Root } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { scanUniverses } from "../core/universe.js";
import {
  readManifest,
  reconcileSlotLinks,
  writeManifest,
} from "../core/links.js";

/**
 * Declarative reconciliation of the cognitive layer across every existing slot:
 * ensures each slot's wormhole tunnels (shared_paths) match the config, prunes
 * managed links that are no longer declared, and drops manifest entries for
 * slots that no longer exist. Idempotent. Does NOT create or remove slots.
 */
export async function runSync(): Promise<void> {
  const root = await findSlot0Root();
  const config = await loadLocalConfig(root);
  const slots = await scanUniverses(root);
  const manifest = await readManifest(root);

  let created = 0;
  let pruned = 0;
  for (const slot of slots) {
    const res = await reconcileSlotLinks(root, slot.path, config.shared_paths, manifest);
    created += res.created.length;
    pruned += res.pruned.length;
    for (const rel of res.created) logger.step(`🔗 ${slot.name}: linked ${rel}`);
    for (const rel of res.pruned) logger.step(`🧹 ${slot.name}: pruned ${rel}`);
    for (const rel of res.skipped) {
      logger.warn(`${slot.name}: ${rel} is a real file, not a managed link — left as-is.`);
    }
  }

  // Garbage-collect manifest entries for slots that no longer exist.
  const live = new Set(slots.map((s) => path.resolve(s.path)));
  for (const key of Object.keys(manifest)) {
    if (!live.has(key)) delete manifest[key];
  }
  await writeManifest(root, manifest);

  logger.success(
    `Synced ${slots.length} universe${slots.length === 1 ? "" : "s"} — ${created} linked, ${pruned} pruned.`
  );
}
