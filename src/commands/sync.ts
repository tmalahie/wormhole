import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { confirm } from "../utils/prompt.js";
import { findSlot0Root, readProjectName } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { scanUniverses } from "../core/universe.js";
import {
  readManifest,
  reconcileSlotLinks,
  writeManifest,
  readDetached,
  writeDetached,
  liveDetached,
  planAdoption,
  executeAdoption,
  formatAdoptionMove,
  tildeify,
  type AdoptionOperation,
} from "../core/links.js";
import type { UniverseSlot } from "../types.js";
import { applyGlobalRecipeWiring, applyRecipeWiring, materializeRecipes } from "../core/recipes.js";
import { resolveStoreLinks } from "../core/stores.js";
import { applyEnv, assertNoEnvCollision } from "../core/env.js";
import { gitHasRemote } from "../core/git.js";
import { globalRoot } from "../core/paths.js";
import { ensureLocalLayout } from "../core/layout.js";
import { loadGlobalConfig } from "../core/global-config.js";
import {
  reconcileGlobalLinks,
  readGlobalManifest,
  writeGlobalManifest,
} from "../core/global-links.js";

export interface SyncOptions {
  /** Reconcile HOME-scope shared links (~/.worm/config.json) instead of a project. */
  global?: boolean;
  /** Skip the confirmation prompt when adoption moves are detected. */
  yes?: boolean;
}

/**
 * Declarative reconciliation of the cognitive layer across every existing slot:
 * ensures each slot's wormhole tunnels (shared_paths) match the config, prunes
 * managed links that are no longer declared, and drops manifest entries for
 * slots that no longer exist. Idempotent. Does NOT create or remove slots.
 *
 * Detects files that exist in slots but should be in the profile (adoption
 * candidates) and shows a plan before executing. With `--yes`, skips confirmation.
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
  // Fail fast on a misconfigured env block (file also declared as a shared_path).
  assertNoEnvCollision(config);
  const projectName = await readProjectName(root);
  // Ensure the consolidated layout (recipes/logs symlinks into the profile,
  // manifest in the profile); migrates an old project in place.
  await ensureLocalLayout(root, projectName);
  const slots = await scanUniverses(root);
  const manifest = await readManifest(projectName);
  // Resolve shared_paths to concrete sources once (clones any missing store).
  const links = await resolveStoreLinks(config, projectName);

  // Detach registry: per-slot tails the user localised. Self-heal each live
  // slot (a deleted local file re-attaches), GC vanished slots, then exclude
  // detached tails per slot from BOTH adoption and reconcile so a detached file
  // stays a local copy instead of being adopted or relinked.
  const detached = await readDetached(projectName);
  const detachedBySlot = new Map<string, string[]>();
  for (const slot of slots) {
    detachedBySlot.set(path.resolve(slot.path), await liveDetached(slot.path, detached));
  }
  const liveKeys = new Set(slots.map((s) => path.resolve(s.path)));
  for (const key of Object.keys(detached)) {
    if (!liveKeys.has(key)) delete detached[key];
  }
  await writeDetached(projectName, detached);
  const slotLinks = (slot: UniverseSlot) => {
    const d = detachedBySlot.get(path.resolve(slot.path)) ?? [];
    return d.length > 0 ? links.filter((l) => !d.includes(l.tail)) : links;
  };

  // Plan adoption (move slot-local files into the profile, then symlink) for
  // every slot, then execute once the whole plan is confirmed conflict-free.
  const allOperations: Array<{ slot: UniverseSlot; operations: AdoptionOperation[] }> = [];
  for (const slot of slots) {
    const plan = await planAdoption(slot.path, slotLinks(slot));
    if (plan.operations.length > 0) {
      allOperations.push({ slot, operations: plan.operations });
    }
  }

  if (allOperations.length > 0) {
    // Per-slot conflicts: a real file/dir exists in both the slot and the profile.
    const conflicts = allOperations.flatMap(({ slot, operations }) =>
      operations
        .filter((o) => o.type === "conflict")
        .map((o) => `  ${slot.name}: ${o.tail} — ${o.conflictReason}`)
    );
    if (conflicts.length > 0) {
      throw new WormError(
        `Cannot adopt — a real file exists in both the slot and the profile:\n${conflicts.join("\n")}`,
        { hint: "Keep the copy you want (delete the other), then re-run `worm sync`." }
      );
    }

    // Cross-slot conflicts: two slots each hold a real file for the same shared
    // path. Adopting both would silently overwrite one in the profile, so refuse.
    const claimants = new Map<string, string[]>();
    for (const { slot, operations } of allOperations) {
      for (const op of operations) {
        if (op.type !== "move") continue;
        const names = claimants.get(op.sourcePath) ?? [];
        names.push(slot.name);
        claimants.set(op.sourcePath, names);
      }
    }
    const collisions = [...claimants.entries()].filter(([, names]) => names.length > 1);
    if (collisions.length > 0) {
      const detail = collisions
        .map(([source, names]) => `  ${tildeify(source)} — claimed by slots ${names.join(", ")}`)
        .join("\n");
      throw new WormError(
        `Cannot adopt — the same shared path is a real file in multiple slots:\n${detail}`,
        { hint: "Keep one copy (let the others become symlinks), then re-run `worm sync`." }
      );
    }

    logger.info("🛸 About to run the following operations:");
    for (const { operations } of allOperations) {
      for (const op of operations) {
        if (op.type === "move") logger.raw(`  ${formatAdoptionMove(op)}`);
      }
    }
    logger.raw("");

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        throw new WormError(
          "Adoption operations detected but running non-interactively.",
          {
            hint: 'Re-run with `--yes` to automatically adopt, or resolve conflicts manually.',
          }
        );
      }
      const ok = await confirm("Proceed?", true);
      if (!ok) {
        logger.info("Aborted.");
        return;
      }
    }

    for (const { slot, operations } of allOperations) {
      await executeAdoption(slot.path, operations);
    }
  }

  let created = 0;
  let pruned = 0;
  for (const slot of slots) {
    const res = await reconcileSlotLinks(slot.path, slotLinks(slot), manifest);
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
    // Refresh this slot's per-worktree env file (no-op unless `env` is configured).
    const envRes = await applyEnv(slot.path, config, slot, slot.branch ?? "");
    if (envRes?.written) logger.step(`📝 ${slot.name}: generated ${envRes.file}`);
  }

  // Garbage-collect manifest entries for slots that no longer exist.
  const live = new Set(slots.map((s) => path.resolve(s.path)));
  for (const key of Object.keys(manifest)) {
    if (!live.has(key)) delete manifest[key];
  }
  await writeManifest(projectName, manifest);

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
  const recipes = config.recipes ?? {};

  // Wire (or strip) GLOBAL-scope recipes into ~/.claude/settings.json — runs
  // regardless of shared_paths (removing `autosync` from config + re-running
  // strips the hooks). autosync needs a git remote on ~/.worm to do anything.
  if (await applyGlobalRecipeWiring(recipes)) {
    logger.step("⚡ wired global recipe hooks → ~/.claude/settings.json");
  }
  // Independent of whether the wiring changed this run: as long as autosync is
  // enabled without a remote it silently no-ops, so surface the reminder every
  // sync (a second already-wired `worm sync --global` shouldn't swallow it).
  if (recipes.autosync && !(await gitHasRemote(globalRoot()))) {
    logger.warn(
      "autosync is enabled but ~/.worm has no git remote — it will no-op until you add one (e.g. `git -C ~/.worm remote add origin <url>`)."
    );
  }

  if (desired.length === 0 && Object.keys(manifest).length === 0) {
    if (Object.keys(recipes).length === 0) {
      logger.info("🪐 Nothing global configured in ~/.worm/config.json.");
      logger.hint(
        'Add e.g. "shared_paths": [".claude/commands"] or "recipes": { "autosync": {} }, then re-run `worm sync --global`.'
      );
    }
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
