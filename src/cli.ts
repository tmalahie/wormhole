import { Command } from "commander";
import { logger } from "./utils/logger.js";
import { isWormError } from "./utils/errors.js";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runConfig } from "./commands/config.js";
import { runPath } from "./commands/path.js";
import { runShellInit } from "./commands/shell-init.js";
import { runDestroy } from "./commands/destroy.js";
import { runClone } from "./commands/clone.js";
import { runCompletion } from "./commands/completion.js";
import { runSync } from "./commands/sync.js";
import { runSwitch } from "./commands/switch.js";
import { runUniverseAdd, runUniverseRemove } from "./commands/universe.js";
import { runHookTrigger } from "./commands/hook.js";

const program = new Command();

program
  .name("worm")
  .description(
    "A permanent pool of warm git worktrees + a personal cognitive layer for AI coding agents."
  )
  .version("0.1.0")
  .showHelpAfterError("(run `worm --help` for usage)")
  .addHelpText(
    "after",
    "\nEnvironment:\n" +
      "  WORM_HOME    Override the global root (default: ~/.worm).\n" +
      "  WORM_DEBUG   Set to 1 to print stack traces on error."
  );

program
  .command("clone <url> [path]")
  .description("Clone a repo and bind it as Slot 0 (the recommended entry point).")
  .option("-n, --name <name>", "Override the multiverse name (default: derived from the URL).")
  .option("-t, --template <dir>", "Seed from a custom template directory.")
  .option("-f, --force", "Overwrite existing profile fields when they conflict.")
  .option("--skip-hook", "Skip the on_create hook that warms up Slot 0.")
  .action(async (url: string, target: string | undefined, opts) => {
    await runClone(url, target, opts);
  });

program
  .command("init")
  .description("Bind the current git clone as Slot 0 of a wormhole multiverse.")
  .option("-n, --name <name>", "Override the project name (default: basename of the repo root).")
  .option("-t, --template <dir>", "Seed from a custom template directory (config.json + optional scripts/).")
  .option("-f, --force", "Overwrite existing profile fields when they conflict.")
  .option("--skip-hook", "Skip the on_create hook that warms up Slot 0.")
  .action(async (opts) => {
    await runInit(opts);
  });

const universe = program
  .command("universe")
  .alias("uni")
  .description("Manage the permanent universe pool (sibling worktrees).");

universe
  .command("add <branch>")
  .description("Create a permanent universe on <branch> as a sibling worktree.")
  .option("-c, --create", "Create the branch if it does not exist yet.")
  .option("--skip-hook", "Skip the on_create hook.")
  .action(async (branch: string, opts) => {
    await runUniverseAdd(branch, opts);
  });

universe
  .command("rm <ref>")
  .alias("remove")
  .description("Remove a sibling universe. `<ref>` is a slot index or a branch. Slot 0 is protected.")
  .option("-f, --force", "Remove even with uncommitted changes.")
  .option("--skip-hook", "Skip the on_remove hook.")
  .action(async (ref: string, opts) => {
    await runUniverseRemove(ref, opts);
  });

program
  .command("switch <branch>")
  .description("Switch the current slot to <branch> in place and re-run the warm-up hook.")
  .option("-c, --create", "Create the branch if it does not exist yet.")
  .option("--skip-hook", "Skip the on_create hook.")
  .action(async (branch: string, opts) => {
    await runSwitch(branch, opts);
  });

program
  .command("sync")
  .description("Reconcile shared-path links across every slot (declarative, idempotent).")
  .option("--global", "Reconcile HOME-scope links (~/.worm/config.json shared_paths) instead of the project.")
  .action(async (opts) => {
    await runSync(opts);
  });

program
  .command("status")
  .description("Show every slot in the universe pool.")
  .option("--json", "Output as JSON.")
  .action(async (opts) => {
    await runStatus(opts);
  });

program
  .command("config [key] [value]")
  .description("Read or write machine-level worm settings (~/.worm/config.json).")
  .option("--list", "Print all keys and values.")
  .option("--unset", "Remove a key.")
  .action(async (key: string | undefined, value: string | undefined, opts) => {
    await runConfig(key, value, opts);
  });

program
  .command("path <ref>")
  .description("Print the worktree path for a branch or slot index. Used by `worm cd` / `worm tp`.")
  .action(async (ref: string) => {
    await runPath(ref);
  });

program
  .command("shell-init")
  .description("Print a shell function enabling `worm cd <branch>` / `worm tp <N>`. Eval the output in your rc file.")
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
  .description("Internal: worm's recipe-hook dispatcher (invoked by a slot's settings.local.json).");

hook
  .command("trigger <event>")
  .description("Run enabled recipes' hooks for <event> (pre-tool-use | session-start | session-end).")
  .action(async (event: string) => {
    await runHookTrigger(event);
  });

program
  .command("destroy")
  .description("Unbind this project: remove sibling universes, .worm/, and the global profile. Slot 0 is left intact.")
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
