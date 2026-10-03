import path from "node:path";
import { run, runOrThrow } from "../utils/exec.js";
import { WormError } from "../utils/errors.js";
import { ensureDir, fs } from "../utils/fs.js";
import { logger } from "../utils/logger.js";

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
}

export async function isInsideRepo(cwd: string): Promise<boolean> {
  const { exitCode } = await run(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { cwd }
  );
  return exitCode === 0;
}

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const { exitCode } = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot }
  );
  return exitCode === 0;
}

export async function remoteBranchExists(
  repoRoot: string,
  branch: string
): Promise<string | null> {
  const { stdout, exitCode } = await run(
    "git",
    ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${branch}`],
    { cwd: repoRoot }
  );
  if (exitCode !== 0) return null;
  const first = stdout.split("\n").find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const { stdout } = await runOrThrow(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: repoRoot },
    "Failed to enumerate git worktrees."
  );
  return parseWorktreePorcelain(stdout);
}

function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const blocks = stdout.split(/\n\n+/);
  const entries: WorktreeEntry[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    let path: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    let detached = false;
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
    }
    if (path) entries.push({ path, head, branch, detached, bare });
  }
  return entries;
}

export async function worktreeAdd(
  repoRoot: string,
  targetPath: string,
  branch: string,
  options: { createIfMissing?: boolean; detach?: boolean; base?: string } = {}
): Promise<void> {
  const args = ["worktree", "add"];

  if (options.detach) {
    // Detached HEAD at branch's tip — doesn't claim refs/heads/<branch>,
    // so it's safe even if the branch is checked out elsewhere.
    if (!(await branchExists(repoRoot, branch))) {
      throw new WormError(`Branch "${branch}" does not exist.`, {
        hint: `Create it first with \`git branch ${branch}\`, or drop --detach to use --create.`,
      });
    }
    args.push("--detach", targetPath, branch);
  } else {
    const exists = await branchExists(repoRoot, branch);
    if (!exists) {
      if (!options.createIfMissing) {
        throw new WormError(`Branch "${branch}" does not exist.`, {
          hint: `Pass --create to spin it up, or create it first with \`git branch ${branch}\`.`,
        });
      }
      const remoteRef = await remoteBranchExists(repoRoot, branch);
      if (remoteRef) {
        args.push("--track", "-b", branch, targetPath, remoteRef);
      } else if (options.base) {
        // --no-track: a new branch cut from origin/main must not track origin/main.
        args.push("--no-track", "-b", branch, targetPath, options.base);
      } else {
        args.push("-b", branch, targetPath);
      }
    } else {
      args.push(targetPath, branch);
    }
  }

  const { exitCode, stderr } = await run("git", args, { cwd: repoRoot });
  if (exitCode === 0) return;
  // A failing post-checkout hook becomes git's exit status even though the
  // checkout itself succeeded — e.g. husky's `.husky/_/post-checkout` sourcing an
  // `h` that only exists once the new worktree's own install has run. If git
  // registered the worktree, it is there: carry on (the caller wires and sets it up).
  const registered = (await listWorktrees(repoRoot)).some(
    (w) => path.resolve(w.path) === path.resolve(targetPath)
  );
  if (!registered) {
    throw new WormError(`Failed to add git worktree at ${targetPath}`, { hint: stderr.trim() || undefined });
  }
  logger.warn(`git's post-checkout hook failed in the new worktree (checkout kept): ${lastLine(stderr)}`);
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "";

export async function worktreeRemove(
  repoRoot: string,
  targetPath: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(targetPath);
  await runOrThrow(
    "git",
    args,
    { cwd: repoRoot },
    `Failed to remove git worktree at ${targetPath}`
  );
}

export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await run("git", ["worktree", "prune"], { cwd: repoRoot });
}

/**
 * Whether the repo at `cwd` has a remote. With `name`, checks that SPECIFIC
 * remote exists (matches what autosync fetches from); without, any remote.
 */
export async function gitHasRemote(cwd: string, name?: string): Promise<boolean> {
  if (name) {
    const { exitCode } = await run("git", ["remote", "get-url", name], { cwd });
    return exitCode === 0;
  }
  const { stdout, exitCode } = await run("git", ["remote"], { cwd });
  return exitCode === 0 && stdout.trim().length > 0;
}

/**
 * Absolute path to the COMMON git dir for the repo at `cwd` (shared by the main worktree
 * and every linked worktree). For the main worktree this is `<root>/.git`; from a linked
 * worktree `git` still reports the common dir, not the worktree's own gitdir.
 * Returns null when `cwd` isn't a git repo.
 */
export async function gitCommonDir(cwd: string): Promise<string | null> {
  const { stdout, exitCode } = await run("git", ["rev-parse", "--git-common-dir"], { cwd });
  if (exitCode !== 0) return null;
  const out = stdout.trim();
  if (!out) return null;
  return path.resolve(cwd, out);
}

/**
 * Idempotently add `entry` to the repo's COMMON `info/exclude`, so it ignores
 * the pattern across every worktree at once (the file is shared). Used for
 * worm-managed local files that must not show up as untracked — `.worm/` and
 * each worktree's generated env file. Non-fatal: silently skips if git can't be
 * reached or the file can't be written.
 */
export async function ensureGitExclude(cwd: string, entry: string): Promise<void> {
  try {
    const common = await gitCommonDir(cwd);
    if (!common) return;
    const excludePath = path.join(common, "info", "exclude");
    let content = "";
    try {
      content = await fs.readFile(excludePath, "utf8");
    } catch {
      // no existing exclude file
    }
    if (content.split("\n").includes(entry)) return;
    await ensureDir(path.dirname(excludePath));
    const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await fs.writeFile(excludePath, content + sep + entry + "\n", "utf8");
  } catch {
    // perms or an exotic git layout — skip silently.
  }
}

/**
 * Current branch name at `repoRoot`, or null when detached / on no branch.
 */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  const { stdout, exitCode } = await run(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoRoot }
  );
  if (exitCode !== 0) return null;
  const name = stdout.trim();
  return name === "HEAD" ? null : name;
}

/**
 * Returns porcelain status lines (modified + untracked) for the given worktree.
 * `--untracked-files=all` so nested untracked paths are listed individually
 * rather than collapsed into their parent directory.
 */
export async function dirtyFiles(worktreePath: string): Promise<string[]> {
  const { stdout, exitCode } = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: worktreePath }
  );
  if (exitCode !== 0) return [];
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/** True when `ref` resolves to a commit (a branch, remote-tracking ref, tag or sha). */
export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  const { exitCode } = await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repoRoot,
  });
  return exitCode === 0;
}

/** `git branch -d` (safe delete: refuses an unmerged branch). Returns git's error, or null. */
export async function deleteMergedBranch(repoRoot: string, branch: string): Promise<string | null> {
  const { exitCode, stderr } = await run("git", ["branch", "-d", branch], { cwd: repoRoot });
  return exitCode === 0 ? null : stderr.trim() || `git branch -d ${branch} failed`;
}

/** Best-effort `git fetch <remote> <branch>` (quiet, bounded); false when it failed or timed out. */
export async function fetchBranch(repoRoot: string, remote: string, branch: string): Promise<boolean> {
  const { exitCode } = await run("git", ["fetch", "--quiet", remote, branch], {
    cwd: repoRoot,
    timeout: 20_000,
  });
  return exitCode === 0;
}

/** The remote's default branch as a ref (`origin/main`), from `refs/remotes/<remote>/HEAD`; null when unknown. */
export async function remoteDefaultRef(repoRoot: string, remote = "origin"): Promise<string | null> {
  const { stdout, exitCode } = await run(
    "git",
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
    { cwd: repoRoot }
  );
  return exitCode === 0 && stdout.trim() ? stdout.trim() : null;
}
