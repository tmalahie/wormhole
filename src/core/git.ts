import { run, runOrThrow } from "../utils/exec.js";
import { WormError } from "../utils/errors.js";

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
  options: { createIfMissing?: boolean } = {}
): Promise<void> {
  const exists = await branchExists(repoRoot, branch);
  const args = ["worktree", "add"];
  if (!exists) {
    if (!options.createIfMissing) {
      throw new WormError(`Branch "${branch}" does not exist.`, {
        hint: `Pass --create to spin it up, or create it first with \`git branch ${branch}\`.`,
      });
    }
    const remoteRef = await remoteBranchExists(repoRoot, branch);
    if (remoteRef) {
      args.push("--track", "-b", branch, targetPath, remoteRef);
    } else {
      args.push("-b", branch, targetPath);
    }
  } else {
    args.push(targetPath, branch);
  }
  await runOrThrow(
    "git",
    args,
    { cwd: repoRoot },
    `Failed to add git worktree at ${targetPath}`
  );
}

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
