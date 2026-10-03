import path from "node:path";
import { WormError } from "../utils/errors.js";
import { fs, isSymlink, pathExists, writeTextIfMissing } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import {
  branchExists,
  deleteMergedBranch,
  dirtyFiles,
  ensureGitExclude,
  fetchBranch,
  listWorktrees,
  pruneWorktrees,
  refExists,
  remoteBranchExists,
  remoteDefaultRef,
  worktreeAdd,
  worktreeRemove,
} from "./git.js";
import {
  WORKTREE_KEEP_FILE_NAME,
  claudeProjectsDir,
  localRoot,
  claudeSlug,
  globalProjectDir,
  syncPermissionsBaseFile,
  worktreeDir,
  worktreesDir,
} from "./paths.js";
import { buildEnvContext, applyEnv, type EnvApplyResult, type EnvContext } from "./env.js";
import { hookEnv, runHook } from "./hooks.js";
import {
  liveDetached,
  readDetached,
  readManifest,
  reconcileWorktreeLinks,
  stripWorktreeLinks,
  writeDetached,
  writeManifest,
  type ReconcileResult,
} from "./links.js";
import { resolveStoreLinks } from "./stores.js";
import { applyRecipeWiring, materializeRecipes } from "./recipes.js";
import { ensureSymlink } from "./symlinks.js";
import { chooseSlot, readSlots, slotOf, writeSlots } from "./slots.js";
import { findMainRoot, gitCommonDir, readProjectName } from "./project.js";
import { loadLocalConfig } from "./config.js";
import type { Config, Worktree } from "../types.js";

/**
 * The worktrees of a worm project: the main worktree (the clone itself, kept on
 * `baseBranch`) plus linked worktrees, normally under `<root>/.claude/worktrees/`
 * — the layout Claude Code and Claude Desktop use, so whoever creates a worktree
 * (`worm worktree add`, Claude's WorktreeCreate hook, the control plane) ends up
 * in the same place with the same setup.
 */

export interface ProjectRef {
  mainRoot: string;
  projectName: string;
  config: Config;
}

/** Resolve the worm project containing `start` (default cwd): main root, name, config. */
export async function openProject(start: string = process.cwd()): Promise<ProjectRef> {
  const mainRoot = await findMainRoot(start);
  const projectName = await readProjectName(mainRoot);
  const config = await loadLocalConfig(mainRoot);
  return { mainRoot, projectName, config };
}

/** Every worktree git knows for the repo (main first, then by name), with its slot. */
export async function listProjectWorktrees(
  mainRoot: string,
  projectName: string
): Promise<Worktree[]> {
  const root = path.resolve(mainRoot);
  const table = await readSlots(projectName);
  const out: Worktree[] = [];
  for (const entry of await listWorktrees(root)) {
    if (entry.bare) continue;
    const wtPath = path.resolve(entry.path);
    if (wtPath !== root && !(await pathExists(wtPath))) continue; // prunable
    const isMain = wtPath === root;
    out.push({
      name: isMain ? "main" : path.basename(wtPath),
      path: wtPath,
      isMain,
      branch: entry.branch,
      head: entry.head,
      detached: entry.detached,
      slot: slotOf(table, wtPath),
    });
  }
  return out.sort((a, b) => (a.isMain ? -1 : b.isMain ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Resolve a user reference to one worktree: a name ("main", "ENG-1-x"), a branch,
 * a path (absolute or relative to cwd), or a slot number (the worktree holding it).
 */
export function resolveWorktreeRef(ref: string, worktrees: Worktree[]): Worktree {
  const byName = worktrees.find((w) => w.name === ref);
  if (byName) return byName;
  const byBranch = worktrees.find((w) => w.branch === ref);
  if (byBranch) return byBranch;
  if (/^\d+$/.test(ref)) {
    const n = Number.parseInt(ref, 10);
    const bySlot = worktrees.find((w) => w.slot === n);
    if (bySlot) return bySlot;
    throw new WormError(`No worktree holds slot ${n}.`, { hint: "Run `worm slot ls`." });
  }
  // A path (absolute, or explicitly relative: ".", "./x", "../x"): the deepest
  // worktree containing it — linked worktrees live inside the main one. A bare
  // word is never read as a path, so a typo'd branch can't resolve to main.
  const looksLikePath = path.isAbsolute(ref) || ref === "." || ref === ".." || /^\.\.?\//.test(ref);
  if (!looksLikePath) {
    throw new WormError(`No worktree matches "${ref}".`, {
      hint: "Pass a worktree name, a branch, a path or a slot number — `worm worktree ls` lists them.",
    });
  }
  const resolved = path.resolve(ref);
  const containing = worktrees
    .filter((w) => resolved === w.path || resolved.startsWith(w.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length);
  if (containing[0]) return containing[0];
  throw new WormError(`No worktree matches "${ref}".`, {
    hint: "Pass a worktree name, a branch, a path or a slot number — `worm worktree ls` lists them.",
  });
}

/** The worktree containing `dir` (default cwd), or null. */
export function worktreeAt(dir: string, worktrees: Worktree[]): Worktree | null {
  try {
    return resolveWorktreeRef(path.resolve(dir), worktrees);
  } catch {
    return null;
  }
}

/**
 * A directory name for a branch: its last path segment ("feat/ENG-1-x" → "ENG-1-x"),
 * restricted to [A-Za-z0-9_-] (dots too become dashes, so the directory and
 * Claude's project slug for it agree).
 */
export function worktreeNameForBranch(branch: string): string {
  const last = branch.split("/").filter(Boolean).pop() ?? branch;
  const name = last.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "worktree";
}

async function uniqueName(mainRoot: string, base: string, taken: Set<string>): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (taken.has(candidate)) continue;
    if (await pathExists(worktreeDir(mainRoot, candidate))) continue;
    return candidate;
  }
}

// --- wiring ------------------------------------------------------------------

/** The env context for a worktree that holds a slot (null when it holds none). */
export function envContextFor(project: ProjectRef, wt: Worktree): EnvContext | null {
  if (wt.slot === null) return null;
  return buildEnvContext({
    index: wt.slot,
    name: wt.name,
    branch: wt.branch ?? "",
    profile: globalProjectDir(project.projectName),
    root: project.mainRoot,
    worktree: wt.path,
  });
}

/**
 * Point a linked worktree's Claude project dir at the main worktree's, so every
 * worktree of the repo shares one transcript dir (one place to resume from, one
 * auto-memory). Leaves a real directory alone (returns "real-dir").
 */
export async function linkClaudeProjectDir(
  mainRoot: string,
  worktreePath: string
): Promise<"linked" | "unchanged" | "real-dir" | "main"> {
  const canonical = claudeSlug(mainRoot);
  const own = claudeSlug(worktreePath);
  if (own === canonical) return "main";
  const linkPath = path.join(claudeProjectsDir(), own);
  if ((await pathExists(linkPath)) && !(await isSymlink(linkPath))) return "real-dir";
  await fs.mkdir(path.join(claudeProjectsDir(), canonical), { recursive: true });
  const res = await ensureSymlink(linkPath, path.join(claudeProjectsDir(), canonical), {
    relative: true,
    type: "dir",
  });
  return res.created ? "linked" : "unchanged";
}

export interface WireResult {
  links: ReconcileResult;
  env: EnvApplyResult | null;
  claudeDir: Awaited<ReturnType<typeof linkClaudeProjectDir>>;
  recipeHooksChanged: boolean;
}

/**
 * Apply the cognitive layer to one worktree: shared-path links (respecting
 * detached tails), the slot env file (rendered or removed), the Claude project
 * dir link, the keep marker, and recipe wiring. Idempotent. Silent — callers log.
 */
export async function wireWorktree(project: ProjectRef, wt: Worktree): Promise<WireResult> {
  const { mainRoot, projectName, config } = project;
  const manifest = await readManifest(projectName);
  const allLinks = await resolveStoreLinks(config, projectName);
  const detached = await readDetached(projectName);
  const detachedTails = await liveDetached(wt.path, detached);
  await writeDetached(projectName, detached);
  const links = detachedTails.length > 0 ? allLinks.filter((l) => !detachedTails.includes(l.tail)) : allLinks;
  const linkRes = await reconcileWorktreeLinks(wt.path, links, manifest);
  await writeManifest(projectName, manifest);

  const env = await applyEnv(wt.path, config, envContextFor(project, wt));
  const claudeDir = await linkClaudeProjectDir(mainRoot, wt.path);

  if (!wt.isMain) {
    // Claude Desktop's worktree GC leaves a worktree alone while this exists.
    await writeTextIfMissing(path.join(wt.path, WORKTREE_KEEP_FILE_NAME), "");
    await ensureGitExclude(wt.path, `/${WORKTREE_KEEP_FILE_NAME}`);
  }
  // worm writes the worktree's hooks into this file; it is machine-local by nature.
  await ensureGitExclude(wt.path, "/.claude/settings.local.json");

  await materializeRecipes(mainRoot, projectName, config.recipes);
  const recipeHooksChanged = await applyRecipeWiring(
    mainRoot,
    projectName,
    { name: wt.name, path: wt.path },
    config.recipes
  );
  return { links: linkRes, env, claudeDir, recipeHooksChanged };
}

// --- create ------------------------------------------------------------------

export interface CreateOptions {
  branch: string;
  /** Directory name under .claude/worktrees (default: derived from the branch). */
  name?: string;
  /** Start point for a new branch (default: origin/<baseBranch>, else <baseBranch>). */
  base?: string;
  /** Skip the on_create hook (dependency install). */
  noSetup?: boolean;
}

/**
 * Create a worktree under `<root>/.claude/worktrees/<name>`, check out (or create)
 * the branch, wire it, and run `on_create`. Refuses a branch already checked out
 * elsewhere (git would too) and names the holder.
 */
export async function createWorktree(project: ProjectRef, opts: CreateOptions): Promise<Worktree> {
  const { mainRoot, projectName, config } = project;
  const branch = opts.branch.trim();
  if (!branch) throw new WormError("Branch name is required.");

  const existing = await listProjectWorktrees(mainRoot, projectName);
  const holder = existing.find((w) => w.branch === branch);
  if (holder) {
    throw new WormError(`Branch "${branch}" is already checked out in ${holder.path}.`, {
      hint: holder.isMain
        ? `The main worktree stays on ${config.baseBranch}; switch it back first (\`git -C ${mainRoot} switch ${config.baseBranch}\`).`
        : `Use that worktree, or remove it first (\`worm worktree rm ${holder.name}\`).`,
    });
  }

  const name = opts.name
    ? worktreeNameForBranch(opts.name)
    : await uniqueName(mainRoot, worktreeNameForBranch(branch), new Set(existing.map((w) => w.name)));
  const target = worktreeDir(mainRoot, name);
  if (await pathExists(target)) {
    throw new WormError(`${target} already exists.`, { hint: "Pick another --name." });
  }

  await fs.mkdir(worktreesDir(mainRoot), { recursive: true });
  // Repos that don't ignore .claude/worktrees themselves must not see them as untracked.
  await ensureGitExclude(mainRoot, "/.claude/worktrees/");

  let base: string | undefined;
  if (!(await branchExists(mainRoot, branch)) && !(await remoteBranchExists(mainRoot, branch))) {
    base = opts.base ?? (await defaultBase(mainRoot, config.baseBranch));
  }
  await worktreeAdd(mainRoot, target, branch, { createIfMissing: true, base });

  const wt: Worktree = { name, path: target, isMain: false, branch, slot: null };
  const wired = await wireWorktree(project, wt);
  if (wired.claudeDir === "real-dir") {
    logger.warn(
      `${claudeSlug(target)} in ~/.claude/projects is a real directory — merge it into ${claudeSlug(mainRoot)} by hand; not linked.`
    );
  }

  if (!opts.noSetup && config.hooks.on_create) {
    const res = await runHook("on_create", config.hooks.on_create, {
      cwd: target,
      env: hookEnv(mainRoot, wt, branch, projectName),
    });
    if (res.ran && res.exitCode !== 0) {
      logger.warn(
        `on_create exited with code ${res.exitCode}. The worktree exists but may not be fully set up.`
      );
    }
  }
  return wt;
}

/** origin/<baseBranch> after a best-effort fetch, else the local <baseBranch>. */
async function defaultBase(mainRoot: string, baseBranch: string): Promise<string> {
  await fetchBranch(mainRoot, "origin", baseBranch);
  if (await refExists(mainRoot, `origin/${baseBranch}`)) return `origin/${baseBranch}`;
  if (await refExists(mainRoot, baseBranch)) return baseBranch;
  throw new WormError(`Neither origin/${baseBranch} nor ${baseBranch} exists.`, {
    hint: 'Set "baseBranch" in the project config, or pass --base <ref>.',
  });
}

// --- slots -------------------------------------------------------------------

/**
 * Give `wt` a slot (its current one, `wanted`, or the lowest free), render its
 * env file and run `on_assign`. Idempotent for a worktree that already holds the
 * slot (re-renders, does not re-run the hook). Returns the slot number.
 */
export async function assignSlot(
  project: ProjectRef,
  wt: Worktree,
  wanted?: number
): Promise<{ slot: number; changed: boolean }> {
  const { projectName, config, mainRoot } = project;
  const table = await readSlots(projectName);
  const choice = chooseSlot(table, config.slots, wt.path, wanted);
  if (choice.changed) {
    table[choice.slot] = { worktree: wt.path, since: Date.now() };
    await writeSlots(projectName, table, config.slots);
  }
  const assigned: Worktree = { ...wt, slot: choice.slot };
  await applyEnv(wt.path, config, envContextFor(project, assigned));
  if (choice.changed && config.hooks.on_assign) {
    const res = await runHook("on_assign", config.hooks.on_assign, {
      cwd: wt.path,
      env: hookEnv(mainRoot, assigned, wt.branch ?? "", projectName),
    });
    if (res.ran && res.exitCode !== 0) {
      logger.warn(`on_assign exited with code ${res.exitCode}; slot ${choice.slot} stays assigned.`);
    }
  }
  return choice;
}

/** Release `wt`'s slot: run `on_release`, delete the env file, free the number. */
export async function releaseSlot(project: ProjectRef, wt: Worktree): Promise<number | null> {
  const { projectName, config, mainRoot } = project;
  const table = await readSlots(projectName);
  const slot = slotOf(table, wt.path);
  if (slot === null) return null;
  if (config.hooks.on_release) {
    const res = await runHook("on_release", config.hooks.on_release, {
      cwd: wt.path,
      env: hookEnv(mainRoot, { ...wt, slot }, wt.branch ?? "", projectName),
    });
    if (res.ran && res.exitCode !== 0) {
      logger.warn(`on_release exited with code ${res.exitCode}; releasing slot ${slot} anyway.`);
    }
  }
  delete table[slot];
  await writeSlots(projectName, table, config.slots);
  await applyEnv(wt.path, config, null);
  return slot;
}

// --- remove ------------------------------------------------------------------

export interface RemoveOptions {
  force?: boolean;
  deleteBranch?: boolean;
  skipHook?: boolean;
}

export interface RemoveResult {
  releasedSlot: number | null;
  branchKept: string | null;
  branchError: string | null;
}

/**
 * Remove a linked worktree and everything worm attached to it: its slot (with
 * on_release), on_remove, managed links and detach records, the Claude project
 * dir link, the syncPermissions base file — then `git worktree remove`. The
 * branch is kept unless `deleteBranch` (safe delete: an unmerged branch stays).
 */
export async function removeWorktree(
  project: ProjectRef,
  wt: Worktree,
  opts: RemoveOptions = {}
): Promise<RemoveResult> {
  const { mainRoot, projectName, config } = project;
  if (wt.isMain) {
    throw new WormError("Refusing to remove the main worktree.", {
      hint: "Only linked worktrees (under .claude/worktrees) can be removed.",
    });
  }
  const dirty = await dirtyFiles(wt.path);
  if (dirty.length > 0 && !opts.force) {
    const preview = dirty.slice(0, 5).map((line) => `    ${line}`).join("\n");
    const tail = dirty.length > 5 ? `\n    … and ${dirty.length - 5} more` : "";
    throw new WormError(`${wt.name} has uncommitted changes in ${wt.path}:\n${preview}${tail}`, {
      hint: "Commit or push them, or pass --force to discard them.",
    });
  }

  const releasedSlot = await releaseSlot(project, wt);

  if (!opts.skipHook && config.hooks.on_remove) {
    const res = await runHook("on_remove", config.hooks.on_remove, {
      cwd: wt.path,
      env: hookEnv(mainRoot, { ...wt, slot: null }, wt.branch ?? "", projectName),
    });
    if (res.ran && res.exitCode !== 0 && !opts.force) {
      throw new WormError(`on_remove exited with code ${res.exitCode}. Aborting to avoid losing state.`, {
        hint: "Pass --force to remove anyway.",
      });
    }
  }

  const manifest = await readManifest(projectName);
  await stripWorktreeLinks(wt.path, manifest);
  delete manifest[wt.path];
  await writeManifest(projectName, manifest);
  const detached = await readDetached(projectName);
  if (detached[wt.path]) {
    delete detached[wt.path];
    await writeDetached(projectName, detached);
  }

  await worktreeRemove(mainRoot, wt.path, { force: true });
  await pruneWorktrees(mainRoot);

  const slugLink = path.join(claudeProjectsDir(), claudeSlug(wt.path));
  if (await isSymlink(slugLink)) await fs.unlink(slugLink);
  await fs.rm(syncPermissionsBaseFile(projectName, wt.name), { force: true });

  let branchKept: string | null = wt.branch ?? null;
  let branchError: string | null = null;
  if (opts.deleteBranch && wt.branch) {
    branchError = await deleteMergedBranch(mainRoot, wt.branch);
    if (!branchError) branchKept = null;
  }
  return { releasedSlot, branchKept, branchError };
}

// --- repos worm doesn't manage ---------------------------------------------------
// Claude's worktree hooks are installed machine-wide, so they also fire in repos
// that aren't worm projects. There the hook must do what Claude does without a
// hook: `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`, cut from
// the remote's default branch — nothing wired, nothing installed.

/** The main worktree of the repo containing `dir`, and whether it is a worm project. */
export async function repoAt(dir: string): Promise<{ mainRoot: string; isWormProject: boolean } | null> {
  const commonDir = await gitCommonDir(dir);
  if (!commonDir) return null;
  const mainRoot = path.dirname(commonDir);
  return { mainRoot, isWormProject: await pathExists(localRoot(mainRoot)) };
}

/** Create (or return) `<repo>/.claude/worktrees/<name>` the way Claude Code would. */
export async function createPlainWorktree(mainRoot: string, rawName: string): Promise<string> {
  const name = worktreeNameForBranch(rawName);
  const target = worktreeDir(mainRoot, name);
  const existing = (await listWorktrees(mainRoot)).find((w) => path.resolve(w.path) === target);
  if (existing) return target;

  const isBranch =
    (await branchExists(mainRoot, rawName)) || (await remoteBranchExists(mainRoot, rawName)) !== null;
  const branch = isBranch ? rawName : `worktree-${name}`;
  let base: string | undefined;
  if (!isBranch && !(await branchExists(mainRoot, branch))) {
    const remoteDefault = await remoteDefaultRef(mainRoot);
    if (remoteDefault) {
      const [remote, ...rest] = remoteDefault.split("/");
      await fetchBranch(mainRoot, remote!, rest.join("/"));
    }
    base = remoteDefault ?? "HEAD";
  }
  await fs.mkdir(worktreesDir(mainRoot), { recursive: true });
  await ensureGitExclude(mainRoot, "/.claude/worktrees/");
  await worktreeAdd(mainRoot, target, branch, { createIfMissing: true, base });
  return target;
}

/** Remove a worktree of a repo worm doesn't manage (the branch is kept). */
export async function removePlainWorktree(mainRoot: string, worktreePath: string): Promise<void> {
  await worktreeRemove(mainRoot, worktreePath, { force: true });
  await pruneWorktrees(mainRoot);
}
