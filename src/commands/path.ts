import { WormError } from "../utils/errors.js";
import { listProjectWorktrees, openProject, resolveWorktreeRef } from "../core/worktrees.js";

/**
 * Print the path of a worktree given its name, branch or slot number. Invoked
 * inside the `worm()` shell wrapper installed by `worm shell-init`, so the parent
 * shell can `cd` into the result.
 */
export async function runPath(ref: string | undefined): Promise<void> {
  if (!ref || ref.trim().length === 0) {
    throw new WormError("Missing worktree name, branch or slot number.", {
      hint: "Usage: worm path <name|branch|slot>",
    });
  }
  const project = await openProject();
  const wt = resolveWorktreeRef(ref, await listProjectWorktrees(project.mainRoot, project.projectName));
  process.stdout.write(wt.path + "\n");
}

/**
 * `worm cd` only changes the parent shell's cwd through the `worm()`
 * function installed by `worm shell-init`; that wrapper intercepts them before
 * they reach the binary. So if this runs at all, the integration is missing —
 * explain how to set it up rather than failing with a raw "unknown command".
 */
export function runShellAlias(alias: "cd", ref: string): never {
  throw new WormError(
    `\`worm ${alias}\` needs worm's shell integration to change your current directory.`,
    {
      hint: `Add \`eval "$(worm shell-init)"\` to your ~/.zshrc or ~/.bashrc, then reload your shell. One-off without it: cd "$(worm path ${ref})"`,
    }
  );
}
