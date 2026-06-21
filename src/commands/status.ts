import path from "node:path";
import pc from "picocolors";
import { logger } from "../utils/logger.js";
import { findSlot0Root } from "../core/project.js";
import { scanUniverses, universeLabel } from "../core/universe.js";
import { autosyncConflictFile } from "../core/paths.js";
import { pathExists, readJson } from "../utils/fs.js";
import type { UniverseSlot } from "../types.js";

export interface StatusOptions {
  json?: boolean;
}

interface AutosyncConflict {
  at?: string;
  machine?: string;
  detail?: string;
}

/** The durable surface for an autosync conflict — the hook has no live UI, so it
 *  drops a marker and `worm status` is where the human reliably sees it. */
async function readAutosyncConflict(): Promise<AutosyncConflict | null> {
  const file = autosyncConflictFile();
  if (!(await pathExists(file))) return null;
  try {
    return await readJson<AutosyncConflict>(file);
  } catch {
    return { detail: "unreadable conflict marker" };
  }
}

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const root = await findSlot0Root();
  const slots = await scanUniverses(root);
  const autosyncConflict = await readAutosyncConflict();

  if (options.json) {
    console.log(JSON.stringify({ root, slots, autosyncConflict }, null, 2));
    return;
  }

  renderStatus(root, slots);
  if (autosyncConflict) renderAutosyncConflict(autosyncConflict);
}

function renderAutosyncConflict(c: AutosyncConflict): void {
  // Rendered on stdout (like the rest of the status report) so the whole thing is
  // one cohesive block — this is the durable surface for a UI-less hook.
  logger.raw("");
  logger.raw(
    pc.yellow(`💥 autosync: ~/.worm has an unresolved conflict${c.at ? ` (since ${c.at})` : ""}.`)
  );
  if (c.detail) logger.raw(`     ${pc.dim(c.detail)}`);
  logger.raw(pc.dim("     💡 Resolve it: cd ~/.worm && git status. It clears on the next clean sync."));
}

function renderStatus(root: string, slots: UniverseSlot[]): void {
  const projectName = path.basename(root);
  logger.raw(`🪐 ${pc.bold("WORMHOLE STATUS")} — ${pc.bold(projectName)}  ${pc.dim(root)}`);
  logger.raw("");

  const labelWidth = Math.max(0, ...slots.map((s) => universeLabel(s).length));
  for (const slot of slots) {
    const icon = slot.isPrimary ? "🛸" : slot.status === "BROKEN" ? "💥" : "🚀";
    const label = universeLabel(slot).padEnd(labelWidth, " ");
    const detail = renderDetail(slot, root);
    logger.raw(`  ${icon} ${label}  ${pc.dim("←")} ${detail}`);
  }

  logger.raw("");
  const broken = slots.filter((s) => s.status === "BROKEN").length;
  const parts = [
    pc.cyan(`🚀 ${slots.length} universe${slots.length === 1 ? "" : "s"}`),
    broken > 0 ? pc.yellow(`💥 ${broken} broken`) : pc.dim("💥 0 broken"),
  ];
  logger.raw(parts.join("   "));
}

function renderDetail(slot: UniverseSlot, root: string): string {
  if (slot.status === "BROKEN") {
    return pc.yellow(slot.reason ?? "unknown anomaly");
  }
  const where = slot.isPrimary ? pc.dim("(Slot 0)") : pc.dim(path.relative(path.dirname(root), slot.path));
  const branch = slot.branch ? pc.bold(slot.branch) : pc.dim("(detached)");
  return `branch ${branch}  ${where}`;
}
