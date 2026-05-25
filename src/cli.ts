import { Command } from "commander";
import { logger } from "./utils/logger.js";
import { isWormError } from "./utils/errors.js";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runWarp } from "./commands/warp.js";
import { runCollapse } from "./commands/collapse.js";
import { runConfig } from "./commands/config.js";
import { runPath } from "./commands/path.js";
import { runShellInit } from "./commands/shell-init.js";
import { runDestroy } from "./commands/destroy.js";
import { runClone } from "./commands/clone.js";
import { runCompletion } from "./commands/completion.js";
import { runUniverses } from "./commands/universes.js";

const program = new Command();

program
  .name("worm")
  .description(
    "Manage warm, parallel git worktree environments for AI coding agents."
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
  .description("Clone a repo into a bare-clone worm container (the recommended entry point).")
  .option("-n, --name <name>", "Override the multiverse name (default: derived from the URL).")
  .option(
    "-u, --universes <count>",
    "Number of universe slots to provision.",
    (val) => Number.parseInt(val, 10)
  )
  .option("-t, --template <dir>", "Seed from a custom template directory.")
  .option("-f, --force", "Overwrite existing profile fields when they conflict.")
  .action(async (url: string, target: string | undefined, opts) => {
    await runClone(url, target, opts);
  });

program
  .command("init")
  .description("Bind an existing bare-clone container to a wormhole profile. Use `worm clone` to set up a new one.")
  .option("-n, --name <name>", "Override the project name (default: basename of project root).")
  .option(
    "-u, --universes <count>",
    "Number of universe slots to provision.",
    (val) => Number.parseInt(val, 10)
  )
  .option(
    "-t, --template <dir>",
    "Seed from a custom template directory (config.json + optional scripts/)."
  )
  .option("-f, --force", "Overwrite existing profile fields when they conflict.")
  .action(async (opts) => {
    await runInit(opts);
  });

program
  .command("universes [count]")
  .description("Print or change the number of universe slots. `worm universes` prints; `worm universes <N>` resizes.")
  .action(async (count: string | undefined) => {
    await runUniverses(count);
  });

program
  .command("status")
  .description("Show the state of every universe slot.")
  .option("--json", "Output as JSON.")
  .action(async (opts) => {
    await runStatus(opts);
  });

program
  .command("warp <branch>")
  .description("Mount a branch into the first available universe slot.")
  .option("-c, --create", "Create the branch if it does not exist yet.")
  .option("-d, --detach", "Check out in detached HEAD — does not claim the branch ref.")
  .option("-o, --open", "Open the new worktree in the editor configured via `worm config editor`.")
  .option("--skip-hook", "Skip the on_warp hook.")
  .action(async (branch: string, opts) => {
    await runWarp(branch, opts);
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

program
  .command("collapse <ref>")
  .description("Free a universe slot. `<ref>` can be a branch name or a 0-based slot index. Anchors stay warm.")
  .option("-f, --force", "Remove the worktree even if it has uncommitted changes.")
  .option("--skip-hook", "Skip the on_collapse hook.")
  .action(async (ref: string, opts) => {
    await runCollapse(ref, opts);
  });

program
  .command("destroy")
  .description("Unbind this project from worm: collapse all warps, remove .worm/, root .gitignore entry, and the global profile.")
  .option("-f, --force", "Skip the confirmation prompt and force-collapse dirty worktrees.")
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
