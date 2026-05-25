import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { ensureDir } from "../utils/fs.js";
import { findContainerRoot, readProjectName } from "../core/project.js";
import { loadGlobalConfig, saveGlobalConfig } from "../core/config.js";
import { scanUniverses } from "../core/universe.js";
import { slotName, slotPath } from "../core/paths.js";

const MIN_UNIVERSES = 1;
const MAX_UNIVERSES = 64;

/**
 * Get or set the universe count for the current project.
 *   `worm universes`     → print the current count
 *   `worm universes 5`   → resize the multiverse (grow or shrink)
 *
 * Growing creates the new slot directories. Shrinking refuses if any
 * universe being removed is active — collapse it first.
 */
export async function runUniverses(target: string | undefined): Promise<void> {
  const projectRoot = await findContainerRoot();
  const projectName = await readProjectName(projectRoot);
  const config = await loadGlobalConfig(projectName);

  if (target === undefined) {
    logger.raw(String(config.universes_count));
    return;
  }

  const desired = Number.parseInt(target, 10);
  if (!Number.isInteger(desired) || String(desired) !== target.trim()) {
    throw new WormError(`"${target}" is not a valid universe count.`);
  }
  if (desired < MIN_UNIVERSES || desired > MAX_UNIVERSES) {
    throw new WormError(
      `Universe count must be between ${MIN_UNIVERSES} and ${MAX_UNIVERSES} (got ${desired}).`
    );
  }

  const current = config.universes_count;
  if (desired === current) {
    logger.info(`Already at ${current} universe${current === 1 ? "" : "s"} — nothing to do.`);
    return;
  }

  if (desired < current) {
    // Shrinking — every slot being removed must be free first.
    const slots = await scanUniverses(projectRoot, config);
    const blockers = slots
      .slice(desired)
      .filter((s) => s.status === "ACTIVE");
    if (blockers.length > 0) {
      const names = blockers.map((s) => `${s.name} (${s.branch ?? "(detached)"})`).join(", ");
      throw new WormError(
        `Cannot shrink to ${desired}: ${blockers.length} active universe${blockers.length === 1 ? "" : "s"} would be cut off — ${names}.`,
        {
          hint: `Collapse them first (e.g. \`worm collapse ${blockers[0]!.name.replace("uni-", "")}\`), then re-run.`,
        }
      );
    }
  }

  await saveGlobalConfig(projectName, { ...config, universes_count: desired });

  if (desired > current) {
    for (let i = current; i < desired; i += 1) {
      await ensureDir(slotPath(projectRoot, slotName(i)));
    }
  }

  const arrow = desired > current ? "→" : "←";
  logger.success(`Multiverse resized: ${current} ${arrow} ${desired} universes.`);
  if (desired < current) {
    logger.hint(
      `Leftover state at .worm/universes/uni-${desired}..uni-${current - 1} is not auto-deleted. Remove manually if you want a clean slate.`
    );
  }
}

