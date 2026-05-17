import { Command } from "commander";
import { logger } from "./utils/logger.js";
import { isWormError } from "./utils/errors.js";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runWarp } from "./commands/warp.js";
import { runCollapse } from "./commands/collapse.js";

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
  .command("init")
  .description("Bind the current project to a wormhole profile. Lazily creates ~/.worm/ on first run.")
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
  .option("--skip-hook", "Skip the on_warp hook.")
  .action(async (branch: string, opts) => {
    await runWarp(branch, opts);
  });

program
  .command("collapse <branch>")
  .description("Detach a branch and free its universe slot. Anchors stay warm.")
  .option("-f, --force", "Remove the worktree even if it has uncommitted changes.")
  .option("--skip-hook", "Skip the on_collapse hook.")
  .action(async (branch: string, opts) => {
    await runCollapse(branch, opts);
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
