import { WormError } from "../utils/errors.js";
import { findSlot0Root } from "../core/project.js";
import { resolveSlotRef, scanUniverses, universeLabel } from "../core/universe.js";

/**
 * Print the worktree path for a branch or slot index. Invoked inside the
 * `worm()` shell wrapper installed by `worm shell-init`, so the parent shell
 * can `cd` into the result.
 */
export async function runPath(ref: string | undefined): Promise<void> {
  if (!ref || ref.trim().length === 0) {
    throw new WormError("Missing branch or slot index.", {
      hint: "Usage: worm path <branch-or-index>",
    });
  }

  const root = await findSlot0Root();
  const slots = await scanUniverses(root);
  const slot = resolveSlotRef(ref, slots);
  if (slot.status === "BROKEN") {
    throw new WormError(
      `${universeLabel(slot)} (${slot.name}) is broken: ${slot.reason ?? "unknown"}.`
    );
  }
  process.stdout.write(slot.path + "\n");
}
