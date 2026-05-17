import path from "node:path";
import pc from "picocolors";
import { logger } from "../utils/logger.js";
import { findProjectRoot, deriveProjectName } from "../core/project.js";
import { loadLocalConfig } from "../core/config.js";
import { scanUniverses, universeLabel } from "../core/universe.js";
import type { UniverseSlot } from "../types.js";

export interface ScanOptions {
  json?: boolean;
}

export async function runScan(options: ScanOptions = {}): Promise<void> {
  const projectRoot = await findProjectRoot();
  const config = await loadLocalConfig(projectRoot);
  const slots = await scanUniverses(projectRoot, config);

  if (options.json) {
    console.log(JSON.stringify({ projectRoot, slots }, null, 2));
    return;
  }

  renderMultiverse(projectRoot, slots);
}

function renderMultiverse(projectRoot: string, slots: UniverseSlot[]): void {
  const projectName = deriveProjectName(projectRoot);
  logger.raw(`🪐 ${pc.bold("MULTIVERSE STATUS")} — ${pc.bold(projectName)}  ${pc.dim(projectRoot)}`);
  logger.raw("");

  const labelWidth = Math.max(...slots.map((s) => universeLabel(s).length));
  for (const slot of slots) {
    const icon = statusIcon(slot.status);
    const label = pad(universeLabel(slot), labelWidth);
    const status = renderStatus(slot.status);
    const detail = renderDetail(slot, projectRoot);
    logger.raw(`  ${icon} ${label}: ${status}   ${pc.dim("←")} ${detail}`);
  }

  logger.raw("");
  const free = slots.filter((s) => s.status === "STABLE").length;
  const active = slots.filter((s) => s.status === "ACTIVE").length;
  const broken = slots.filter((s) => s.status === "BROKEN").length;
  const parts = [
    `${pc.green(`🌌 ${free} free`)}`,
    `${pc.cyan(`🚀 ${active} active`)}`,
    broken > 0 ? pc.yellow(`💥 ${broken} broken`) : pc.dim("💥 0 broken"),
  ];
  logger.raw(parts.join("   "));
}

function statusIcon(status: UniverseSlot["status"]): string {
  switch (status) {
    case "STABLE":
      return "🌌";
    case "ACTIVE":
      return "🚀";
    case "BROKEN":
      return "💥";
  }
}

function renderStatus(status: UniverseSlot["status"]): string {
  switch (status) {
    case "STABLE":
      return pc.green("[STABLE]");
    case "ACTIVE":
      return pc.cyan("[ACTIVE]");
    case "BROKEN":
      return pc.yellow("[BROKEN]");
  }
}

function renderDetail(slot: UniverseSlot, projectRoot: string): string {
  if (slot.status === "ACTIVE") {
    const relSrc = path.relative(projectRoot, slot.srcPath);
    return `branch ${pc.bold(slot.branch ?? "?")}  ${pc.dim(relSrc)}`;
  }
  if (slot.status === "BROKEN") {
    return pc.yellow(slot.reason ?? "unknown anomaly");
  }
  return pc.dim("(Available)");
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}
