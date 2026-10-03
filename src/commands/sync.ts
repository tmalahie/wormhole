import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { confirm } from "../utils/prompt.js";
import { listProjectWorktrees, openProject, wireWorktree } from "../core/worktrees.js";
import {
  readManifest,
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
import type { Worktree } from "../types.js";
import { applyGlobalRecipeWiring } from "../core/recipes.js";
import { resolveStoreLinks } from "../core/stores.js";
import { assertNoEnvCollision } from "../core/env.js";
import { gitHasRemote } from "../core/git.js";
import { globalRoot, projectFile, workspaceFile } from "../core/paths.js";
import { pathExists, readJson, writeJson, writeTextChanged } from "../utils/fs.js";
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
 * Declarative reconciliation of the cognitive layer across every existing worktree:
 * ensures each worktree's wormhole tunnels (shared_paths) match the config, prunes
 * managed links that are no longer declared, and drops manifest entries for
 * worktrees that no longer exist. Idempotent. Does NOT create or remove worktrees.
 *
 * Detects files that exist in worktrees but should be in the profile (adoption
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
  const project = await openProject();
  const { mainRoot: root, config, projectName } = project;
  // Fail fast on a misconfigured env block (file also declared as a shared_path).
  assertNoEnvCollision(config);
  // Ensure the consolidated layout (recipes/logs symlinks into the profile,
  // manifest in the profile); migrates an old project in place.
  await ensureLocalLayout(root, projectName);
  const worktrees = await listProjectWorktrees(root, projectName);
  // Resolve shared_paths to concrete sources once (clones any missing store).
  const links = await resolveStoreLinks(config, projectName);

  // Detach registry: per-worktree tails the user localised. Self-heal each live
  // worktree (a deleted local file re-attaches), GC vanished worktrees, then exclude
  // detached tails per worktree from BOTH adoption and reconcile so a detached file
  // stays a local copy instead of being adopted or relinked.
  const detached = await readDetached(projectName);
  const detachedByWorktree = new Map<string, string[]>();
  for (const worktree of worktrees) {
    detachedByWorktree.set(path.resolve(worktree.path), await liveDetached(worktree.path, detached));
  }
  const liveKeys = new Set(worktrees.map((s) => path.resolve(s.path)));
  for (const key of Object.keys(detached)) {
    if (!liveKeys.has(key)) delete detached[key];
  }
  await writeDetached(projectName, detached);
  const worktreeLinks = (worktree: Worktree) => {
    const d = detachedByWorktree.get(path.resolve(worktree.path)) ?? [];
    return d.length > 0 ? links.filter((l) => !d.includes(l.tail)) : links;
  };

  // Plan adoption (move worktree-local files into the profile, then symlink) for
  // every worktree, then execute once the whole plan is confirmed conflict-free.
  const allOperations: Array<{ worktree: Worktree; operations: AdoptionOperation[] }> = [];
  for (const worktree of worktrees) {
    const plan = await planAdoption(worktree.path, worktreeLinks(worktree));
    if (plan.operations.length > 0) {
      allOperations.push({ worktree, operations: plan.operations });
    }
  }

  if (allOperations.length > 0) {
    // Per-worktree conflicts: a real file/dir exists in both the worktree and the profile.
    const conflicts = allOperations.flatMap(({ worktree, operations }) =>
      operations
        .filter((o) => o.type === "conflict")
        .map((o) => `  ${worktree.name}: ${o.tail} — ${o.conflictReason}`)
    );
    if (conflicts.length > 0) {
      throw new WormError(
        `Cannot adopt — a real file exists in both the worktree and the profile:\n${conflicts.join("\n")}`,
        { hint: "Keep the copy you want (delete the other), then re-run `worm sync`." }
      );
    }

    // Cross-worktree conflicts: two worktrees each hold a real file for the same shared
    // path. Adopting both would silently overwrite one in the profile, so refuse.
    const claimants = new Map<string, string[]>();
    for (const { worktree, operations } of allOperations) {
      for (const op of operations) {
        if (op.type !== "move") continue;
        const names = claimants.get(op.sourcePath) ?? [];
        names.push(worktree.name);
        claimants.set(op.sourcePath, names);
      }
    }
    const collisions = [...claimants.entries()].filter(([, names]) => names.length > 1);
    if (collisions.length > 0) {
      const detail = collisions
        .map(([source, names]) => `  ${tildeify(source)} — claimed by worktrees ${names.join(", ")}`)
        .join("\n");
      throw new WormError(
        `Cannot adopt — the same shared path is a real file in multiple worktrees:\n${detail}`,
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

    for (const { worktree, operations } of allOperations) {
      await executeAdoption(worktree.path, operations);
    }
  }

  // Wire every worktree (links, slot env file, Claude project dir, recipe + worktree hooks).
  let created = 0;
  let pruned = 0;
  for (const wt of worktrees) {
    const res = await wireWorktree(project, wt);
    created += res.links.created.length;
    pruned += res.links.pruned.length;
    for (const rel of res.links.created) logger.step(`🔗 ${wt.name}: linked ${rel}`);
    for (const rel of res.links.pruned) logger.step(`🧹 ${wt.name}: pruned ${rel}`);
    for (const rel of res.links.skipped) {
      logger.warn(`${wt.name}: ${rel} is a real file, not a managed link — left as-is.`);
    }
    for (const rel of res.links.missing) {
      logger.warn(`${wt.name}: ${rel} — store source not found yet; not linked.`);
    }
    if (res.env?.change === "written") logger.step(`📝 ${wt.name}: generated ${res.env.file} (slot ${wt.slot})`);
    if (res.env?.change === "removed") logger.step(`🧹 ${wt.name}: removed ${res.env.file} (no slot)`);
    if (res.claudeDir === "linked") logger.step(`🔗 ${wt.name}: Claude project dir → main's`);
    if (res.claudeDir === "real-dir") {
      logger.warn(`${wt.name}: its Claude project dir is a real directory — merge it into the main one by hand.`);
    }
    if (res.recipeHooksChanged) logger.step(`⚡ ${wt.name}: hooks rewired`);
  }

  // Drop manifest entries for worktrees that no longer exist.
  const manifest = await readManifest(projectName);
  const live = new Set(worktrees.map((s) => path.resolve(s.path)));
  for (const key of Object.keys(manifest)) {
    if (!live.has(key)) delete manifest[key];
  }
  await writeManifest(projectName, manifest);

  if (await writeProjectFile(projectName, root)) logger.step("📝 project.json");
  const ws = await syncWorkspaceFile(projectName, root);
  if (ws === "created") logger.step(`📝 ${projectName}.code-workspace`);
  if (ws === "unparseable") logger.warn(`${projectName}.code-workspace is not plain JSON — left as-is.`);

  logger.success(
    `Synced ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"} — ${created} linked, ${pruned} pruned.`
  );
}

/** `project.json` = `{ root }`: lets tools go from the profile to the repo. */
async function writeProjectFile(projectName: string, root: string): Promise<boolean> {
  return writeTextChanged(projectFile(projectName), JSON.stringify({ root }, null, 2) + "\n");
}

/**
 * The project's VS Code workspace file: one folder (the main worktree; the
 * worm-vscode extension swaps it to show another worktree, and VS Code saves that
 * back into this file — so an existing file keeps its folders) and a window title
 * that keeps the project name whichever worktree is shown.
 */
async function syncWorkspaceFile(
  projectName: string,
  root: string
): Promise<"created" | "updated" | "unchanged" | "unparseable"> {
  const file = workspaceFile(projectName);
  const title = `${projectName} · \${rootName}\${separator}\${activeEditorShort}`;
  if (!(await pathExists(file))) {
    await writeJson(file, { folders: [{ path: root }], settings: { "window.title": title } });
    return "created";
  }
  let ws: { settings?: Record<string, unknown> } & Record<string, unknown>;
  try {
    ws = await readJson(file);
  } catch {
    return "unparseable";
  }
  if (ws.settings?.["window.title"] === title) return "unchanged";
  ws.settings = { ...(ws.settings ?? {}), "window.title": title };
  await writeJson(file, ws);
  return "updated";
}

/**
 * Reconcile HOME-scope shared links from the global config. Independent of any
 * project — never resolves the main worktree. Idempotent; does not provision `~/.worm`
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
  // enabled without the remote it targets, it silently no-ops, so surface the
  // reminder every sync (a second already-wired `worm sync --global` shouldn't
  // swallow it). Check the SPECIFIC remote autosync uses — a differently-named
  // remote present wouldn't help it.
  if (recipes.autosync) {
    const remote = recipes.autosync.remote;
    if (!(await gitHasRemote(globalRoot(), remote))) {
      logger.warn(
        `autosync is enabled but ~/.worm has no git remote "${remote}" — it will no-op until you add one (e.g. \`git -C ~/.worm remote add ${remote} <url>\`).`
      );
    }
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
