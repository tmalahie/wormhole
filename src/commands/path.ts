import { WormError } from "../utils/errors.js";
import { findContainerRoot } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import {
  resolveSlotRef,
  scanUniverses,
  universeLabel,
} from "../core/universe.js";

/**
 * Print the worktree path for a branch or slot index. Designed to be invoked
 * inside the `worm()` shell wrapper installed by `worm shell-init`, so the
 * parent shell can `cd` into the result.
 */
export async function runPath(ref: string | undefined): Promise<void> {
  if (!ref || ref.trim().length === 0) {
    throw new WormError("Missing branch or slot index.", {
      hint: "Usage: worm path <branch-or-index>",
    });
  }

  const projectRoot = await findContainerRoot();
  const config = await loadLocalConfig(projectRoot);
  const slots = await scanUniverses(projectRoot, config);

  // path resolves both stable and active slots — `worm tp 1` to navigate into
  // an empty universe is a valid use case (you'll just see an empty dir).
  const slot = resolveSlotRef(ref, slots);
  if (slot.status === "BROKEN") {
    throw new WormError(
      `${universeLabel(slot)} (${slot.name}) is broken: ${slot.reason ?? "unknown"}.`
    );
  }
  process.stdout.write(slot.srcPath + "\n");
}
