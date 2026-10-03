import { createRequire } from "node:module";
import { Command } from "commander";
import { logger } from "./utils/logger.js";
import { isWormError } from "./utils/errors.js";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runPath, runShellAlias } from "./commands/path.js";
import { runShellInit } from "./commands/shell-init.js";
import { runDestroy } from "./commands/destroy.js";
import { runClone } from "./commands/clone.js";
import { runCompletion } from "./commands/completion.js";
import { runSync } from "./commands/sync.js";
import { runWire } from "./commands/wire.js";
import { runDetach } from "./commands/detach.js";
import {
  runWorktreeAdd,
  runWorktreeList,
  runWorktreePath,
  runWorktreeRemove,
} from "./commands/worktree.js";
import { runSlotAssign, runSlotCurrent, runSlotList, runSlotRelease } from "./commands/slot.js";
import { runHookTrigger, runHookWorktreeCreate, runHookWorktreeRemove } from "./commands/hook.js";
import { runTemplateRender } from "./commands/template.js";

// Single source of truth for the version: read it from package.json at runtime
// rather than duplicating the literal here. `../package.json` resolves relative
// to the built `dist/cli.js` (npm ships package.json at the tarball root, so it's
// present both in dev and once installed). A dynamic require keeps esbuild from
// inlining the whole manifest into the bundle.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("worm")
  .description(
    "Git worktrees under .claude/worktrees, numbered runtime slots, and a personal cognitive layer for AI coding agents."
  )
  .version(version)
  .showHelpAfterError("(run `worm --help` for usage)")
  .addHelpText(
    "after",
    "\nEnvironment:\n" +
      "  WORM_HOME    Override the global root (default: ~/.worm).\n" +
      "  WORM_DEBUG   Set to 1 to print stack traces on error."
  );

program
  .command("clone <url> [path]")
  .description("Clone a repo and bind it (the recommended entry point).")
  .option("-n, --name <name>", "Override the project name (default: derived from the URL).")
  .option("-t, --template <dir>", "Seed from a custom template directory.")
  .option("-f, --force", "Overwrite existing profile fields when they conflict.")
  .option("--skip-hook", "Skip the on_create hook that sets up the main worktree.")
  .action(async (url: string, target: string | undefined, opts) => {
    await runClone(url, target, opts);
  });

program
  .command("init")
  .description("Bind the current git clone (its main worktree) to a worm project.")
  .option("-n, --name <name>", "Override the project name (default: basename of the repo root).")
  .option("-t, --template <dir>", "Seed from a custom template directory (config.json + optional scripts/).")
  .option("-f, --force", "Overwrite existing profile fields when they conflict.")
  .option("--skip-hook", "Skip the on_create hook that sets up the main worktree.")
  .action(async (opts) => {
    await runInit(opts);
  });

const worktree = program
  .command("worktree")
  .alias("wt")
  .description("Manage the project's worktrees (<root>/.claude/worktrees/<name>).");

worktree
  .command("add <branch>")
  .description("Create a worktree for <branch> (checked out, or created from --base), wire it and set it up.")
  .option("--name <dir>", "Directory name under .claude/worktrees (default: from the branch).")
  .option("--base <ref>", "Start point for a new branch (default: origin/<baseBranch>).")
  .option("--no-setup", "Skip the on_create hook (dependency install).")
  .option("--json", "Print {path, name, branch} as JSON.")
  .action(async (branch: string, opts) => {
    await runWorktreeAdd(branch, opts);
  });

worktree
  .command("rm <ref>")
  .alias("remove")
  .description("Remove a worktree (name, branch, path or slot). The main worktree is protected.")
  .option("-f, --force", "Remove even with uncommitted changes.")
  .option("--delete-branch", "Also delete the branch when it is merged.")
  .option("--skip-hook", "Skip the on_remove hook.")
  .action(async (ref: string, opts) => {
    await runWorktreeRemove(ref, opts);
  });

worktree
  .command("ls")
  .alias("list")
  .description("List every worktree (main first) with branch, uncommitted changes and slot.")
  .option("--json", "Output as JSON.")
  .action(async (opts) => {
    await runWorktreeList(opts);
  });

worktree
  .command("path <ref>")
  .description("Print a worktree's path (name, branch or slot number).")
  .action(async (ref: string) => {
    await runWorktreePath(ref);
  });

const slot = program
  .command("slot")
  .description("Runtime slots: numbered port namespaces a worktree borrows to run its stack.");

slot
  .command("ls")
  .alias("list")
  .description("Show which worktree holds each slot.")
  .option("--json", "Output as JSON.")
  .action(async (opts) => {
    await runSlotList(opts);
  });

slot
  .command("assign [worktree] [n]")
  .description("Give a worktree (default: the current one) a slot (default: the lowest free). Renders its env file, runs on_assign.")
  .action(async (a?: string, b?: string) => {
    await runSlotAssign(a, b);
  });

slot
  .command("release [ref]")
  .description("Release a worktree's slot (default: the current one; or pass a slot number). Runs on_release, removes the env file.")
  .action(async (ref?: string) => {
    await runSlotRelease(ref);
  });

slot
  .command("current")
  .description("Print the current worktree's slot; exits 1 when it holds none.")
  .action(async () => {
    await runSlotCurrent();
  });

program
  .command("sync")
  .description("Reconcile every worktree's links, env file and hooks; write project.json and the VS Code workspace (idempotent).")
  .option("--global", "Reconcile HOME-scope links (~/.worm/config.json shared_paths) instead of the project.")
  .option("-y, --yes", "Skip the confirmation prompt when adoption moves are detected.")
  .action(async (opts) => {
    await runSync(opts);
  });

program
  .command("wire [path]")
  .description("Apply the cognitive layer (tunnels, env, recipes) to a worktree worm didn't create (default: cwd).")
  .action(async (pathArg: string | undefined) => {
    await runWire(pathArg);
  });

program
  .command("detach <file>")
  .description("Sever a shared-path tunnel in the current worktree only — replace the symlink with a local copy.")
  .action(async (file: string) => {
    await runDetach(file);
  });

const template = program
  .command("template")
  .description("Worm's templating primitive: render {{var}} template files.");

template
  .command("render <file> [vars...]")
  .description("Render a {{var}} template file with KEY=VALUE vars to stdout (for setup scripts).")
  .action(async (file: string, vars: string[] = []) => {
    await runTemplateRender(file, vars);
  });

program
  .command("status")
  .description("Show the project's worktrees and their slots.")
  .option("--json", "Output as JSON.")
  .action(async (opts) => {
    await runStatus(opts);
  });

program
  .command("path <ref>")
  .description("Print a worktree's path (name, branch or slot number). Used by `worm cd`.")
  .action(async (ref: string) => {
    await runPath(ref);
  });

program
  .command("cd <ref>")
  .description("cd into a worktree (name, branch or slot number). Requires `worm shell-init`.")
  .action((ref: string) => {
    runShellAlias("cd", ref);
  });

program
  .command("shell-init")
  .description("Print a shell function enabling `worm cd <worktree>`. Eval the output in your rc file.")
  .action(() => {
    runShellInit();
  });

program
  .command("completion <shell>")
  .description("Print a tab-completion script for the given shell (bash | zsh). Source via `eval \"$(worm completion zsh)\"`.")
  .action((shell: string) => {
    runCompletion(shell);
  });

const hook = program
  .command("hook")
  .description("Internal: hooks invoked by Claude Code (recipe dispatcher, worktree create/remove).");

hook
  .command("worktree-create")
  .description("Claude's WorktreeCreate hook: JSON on stdin, prints the worktree path.")
  .action(async () => {
    await runHookWorktreeCreate();
  });

hook
  .command("worktree-remove")
  .description("Claude's WorktreeRemove hook: JSON on stdin, removes that worktree.")
  .action(async () => {
    await runHookWorktreeRemove();
  });

hook
  .command("trigger <event>")
  .description("Run enabled recipes' hooks for <event> (pre-tool-use | session-start | session-end | stop).")
  .option("--global", "Run machine-wide recipes from ~/.worm/config.json (no project context).")
  .action(async (event: string, opts) => {
    await runHookTrigger(event, opts);
  });

program
  .command("destroy")
  .description("Unbind this project: remove linked worktrees, .worm/, and the global profile. The main worktree is left intact.")
  .option("-f, --force", "Skip the confirmation prompt and force-remove dirty worktrees.")
  .action(async (opts) => {
    await runDestroy(opts);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isWormError(err)) {
      logger.error(err.message);
      if (err.hint) logger.hint(err.hint);
      process.exit(1);
    }
    if (err instanceof Error) {
      logger.error(err.message);
      if (process.env.WORM_DEBUG === "1" && err.stack) {
        console.error(err.stack);
      }
      process.exit(1);
    }
    logger.error(String(err));
    process.exit(1);
  }
}

void main();
