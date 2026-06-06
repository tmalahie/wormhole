import { execa } from "execa";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORM_BIN = path.resolve(HERE, "..", "dist", "cli.js");
// Worm-owned recipe code ships with the binary at dist/recipes/ (it is NOT
// copied into a project's .worm/recipes/), so tests resolve it from here.
export const PACKAGED_RECIPES = path.resolve(HERE, "..", "dist", "recipes");

/**
 * Spin up an isolated sandbox:
 *   - A standalone seed repo (with `main` and one commit) to clone from.
 *   - A NORMAL clone at `projectRoot` — this is Slot 0 (Strategy 3: no bare container).
 *   - An empty WORM_HOME pointed nowhere near the real `~/.worm`.
 *
 * Returns `worm(args, opts?)` to invoke the CLI and `cleanup()` to tear down,
 * including any sibling pool worktrees (`<projectRoot>-uniN`).
 */
export async function createSandbox() {
  const wormHome = await mkdtemp(path.join(tmpdir(), "worm-home-"));
  const seedRepo = await mkdtemp(path.join(tmpdir(), "worm-seed-"));
  await initSeedRepo(seedRepo);

  const projectRoot = await mkdtemp(path.join(tmpdir(), "worm-proj-"));
  await buildNormalClone(projectRoot, seedRepo);

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
    // Sibling pool worktrees live at <parent>/<base>-uniN.
    const parent = path.dirname(projectRoot);
    const base = path.basename(projectRoot);
    try {
      for (const entry of await readdir(parent)) {
        if (entry.startsWith(`${base}-`)) {
          await rm(path.join(parent, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // parent vanished — nothing to sweep
    }
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

async function buildNormalClone(projectDir, seedRepo) {
  // git clone into an existing empty directory is allowed.
  await execa("git", ["clone", "--quiet", seedRepo, projectDir]);
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
  await execa("git", ["config", "user.name", "Tester"], { cwd: projectDir });
}

export async function createBranch(repoRoot, name) {
  await execa("git", ["branch", name], { cwd: repoRoot });
}
