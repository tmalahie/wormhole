import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORM_BIN = path.resolve(HERE, "..", "dist", "cli.js");

/**
 * Spin up an isolated sandbox:
 *   - A standalone seed repo (with `main` and one commit) so git operations have something to clone from.
 *   - A bare-clone worm container at `projectRoot` (the `.bare/` + `.git` pointer pattern).
 *   - An empty WORM_HOME pointed nowhere near the real `~/.worm`.
 *
 * Returns `worm(args, opts?)` to invoke the CLI inside the container and `cleanup()` to tear everything down.
 */
export async function createSandbox() {
  const wormHome = await mkdtemp(path.join(tmpdir(), "worm-home-"));
  const seedRepo = await mkdtemp(path.join(tmpdir(), "worm-seed-"));
  await initSeedRepo(seedRepo);

  const projectRoot = await mkdtemp(path.join(tmpdir(), "worm-proj-"));
  await buildBareCloneContainer(projectRoot, seedRepo);

  async function worm(args, opts = {}) {
    return execa("node", [WORM_BIN, ...args], {
      cwd: opts.cwd ?? projectRoot,
      env: {
        ...process.env,
        WORM_HOME: opts.wormHome ?? wormHome,
        HOME: opts.home ?? wormHome,
      },
      reject: false,
    });
  }

  async function cleanup() {
    await rm(wormHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
    await rm(seedRepo, { recursive: true, force: true });
  }

  return { wormHome, projectRoot, seedRepo, worm, cleanup };
}

async function initSeedRepo(dir) {
  const cwd = { cwd: dir };
  await execa("git", ["init", "-q", "-b", "main"], cwd);
  await execa("git", ["config", "user.email", "test@example.com"], cwd);
  await execa("git", ["config", "user.name", "Tester"], cwd);
  await writeFile(path.join(dir, "README.md"), "seed\n");
  await execa("git", ["add", "."], cwd);
  await execa("git", ["commit", "-q", "-m", "initial"], cwd);
}

async function buildBareCloneContainer(containerDir, seedRepo) {
  await execa("git", ["clone", "--bare", "--quiet", seedRepo, path.join(containerDir, ".bare")]);
  await writeFile(path.join(containerDir, ".git"), "gitdir: ./.bare\n");
  // Set identity inside the bare clone so subsequent commits made via test helpers work.
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: containerDir });
  await execa("git", ["config", "user.name", "Tester"], { cwd: containerDir });
}

export async function createBranch(repoRoot, name) {
  await execa("git", ["branch", name], { cwd: repoRoot });
}
