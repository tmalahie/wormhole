#!/usr/bin/env node
// The `syncGlobalPermissions` recipe's worker, shipped WITH worm. The GLOBAL
// analogue of the per-project `syncPermissions` recipe: keeps a configurable set
// of top-level keys of the user-level ~/.claude/settings.json (default:
// `permissions` + `sandbox` + every top-level primitive) in step with a
// git-tracked canonical copy in the worm repo, so those settings are
// version-controlled (and synced across machines once autosync pushes them). The
// key set is passed as CLI args by the recipe wiring, e.g.
// `node sync-global-settings.js permissions sandbox hooks tui` — or `"*"` for
// every key bar the denylist in ../_lib/settings-merge.js.
//
// The live global file can't be a symlink into worm — Claude's permission dialog
// edits it in place — hence this copy-and-merge. The live file also holds keys
// worm has no business syncing (marketplaces, trustedDirectories, …): only the
// configured surface is ever touched, and the canonical copy holds ONLY that
// surface, so the rest of the global config stays local and untracked.
//
// Conflict resolution is a THREE-WAY merge (../_lib/settings-merge.js) against a
// machine-local "base" snapshot (`~/.worm/.sync-global-settings.base.json`,
// gitignored) recording the synced surface as of the last run — the common
// ancestor. The merge recurses, so arrays merge as sets, nested objects merge
// per key, and only a leaf edited on BOTH sides falls back to last-edited-wins.
// After merging, both files AND the base snapshot are rewritten to the result, so
// the next run has an up-to-date ancestor.
//
// Invoked by the GLOBAL dispatch (`worm hook trigger --global <session-start|stop|
// session-end>`). Ignores stdin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySurface,
  expandKeys,
  merge3,
  mtime,
  readJson,
  splitWormHooks,
  withWormHooks,
  writeIfChanged,
} from "../_lib/settings-merge.js";

const wormHome =
  process.env.WORM_HOME && process.env.WORM_HOME.trim()
    ? path.resolve(process.env.WORM_HOME)
    : path.join(os.homedir(), ".worm");

const liveFile = path.join(os.homedir(), ".claude", "settings.json");
const canonicalFile = path.join(wormHome, "shared", ".claude", "settings.json");
// Machine-local 3-way ancestor. Kept out of git (see ensureIgnored) so autosync
// never pushes it — each machine tracks divergence against its OWN last sync.
const baseFile = path.join(wormHome, ".sync-global-settings.base.json");
const BASE_IGNORE_NAME = ".sync-global-settings.base.json";

// Defensively ensure the base snapshot is gitignored even on installs whose
// ~/.worm/.gitignore predates this file (init.ts owns the canonical list, but the
// recipe may run — and autosync fire — before the user re-runs `worm init`).
function ensureIgnored(name) {
  const gitignore = path.join(wormHome, ".gitignore");
  let current = "";
  try {
    current = fs.readFileSync(gitignore, "utf8");
  } catch {
    return; // no ~/.worm/.gitignore yet → not a git-tracked worm home; nothing to guard
  }
  if (current.split(/\r?\n/).includes(name)) return;
  fs.writeFileSync(gitignore, current.replace(/\n?$/, "\n") + name + "\n");
}

// The two structured blocks worm has always synced, regardless of mode.
const ALWAYS_SYNC = ["permissions", "sandbox"];
// Configured key set from CLI args (recipe config `keys`), else auto mode.
const CONFIGURED_KEYS = process.argv.slice(2);

// A value cheap enough to sync without being asked: string/number/boolean/null.
const isPrimitive = (v) => v === null || typeof v !== "object";

// Resolve which top-level keys to sync this run. A configured list wins (with
// `"*"` expanded against the live files); otherwise AUTO mode = permissions +
// sandbox + every top-level primitive-valued key found on either side, so scalar
// prefs like effortLevel/tui sync with zero config. Auto mode deliberately stops
// there: the merge handles structure fine, but whether e.g. `hooks` SHOULD follow
// you to another machine is a judgement call — `keys` (or `"*"`) is where you
// make it.
function syncedKeys(live, canon, base) {
  if (CONFIGURED_KEYS.length) return expandKeys(CONFIGURED_KEYS, [live, canon, base]);
  const keys = new Set(ALWAYS_SYNC);
  for (const src of [live, canon, base]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (ALWAYS_SYNC.includes(k)) continue;
      if (isPrimitive(v)) keys.add(k);
    }
  }
  return [...keys];
}

function main() {
  const live = readJson(liveFile);
  if (live === null) return; // no global settings file — nothing to sync
  const canon = readJson(canonicalFile) || {};
  const base = readJson(baseFile) || {};
  const liveNewer = mtime(liveFile) >= mtime(canonicalFile);
  const keys = syncedKeys(live, canon, base);

  // `hooks` is merged on its USER-owned entries only — worm's own dispatch
  // entries are re-attached to the live file afterwards and never leave the
  // machine (see the note in ../_lib/settings-merge.js).
  const [liveUserHooks, liveWormHooks] = splitWormHooks(live.hooks);
  const [canonUserHooks] = splitWormHooks(canon.hooks);
  const [baseUserHooks] = splitWormHooks(base.hooks);

  // The synced surface: each key three-way-merged, recursively.
  const surface = {};
  const liveOverrides = {};
  for (const key of keys) {
    if (key === "hooks") {
      const merged = merge3(baseUserHooks, liveUserHooks, canonUserHooks, liveNewer);
      if (merged !== undefined) surface.hooks = merged;
      const attached = withWormHooks(merged, liveWormHooks);
      if (attached !== undefined) liveOverrides.hooks = attached;
      continue;
    }
    const merged = merge3(base[key], live[key], canon[key], liveNewer);
    if (merged !== undefined) surface[key] = merged;
  }

  // Canonical holds only the tracked surface (the configured keys); the live file
  // keeps every other key untouched, with only that surface overlaid.
  const wroteCanon = writeIfChanged(canonicalFile, surface);
  const wroteLive = writeIfChanged(liveFile, applySurface(live, keys, surface, liveOverrides));
  // Advance the 3-way ancestor to the state both files now hold.
  ensureIgnored(BASE_IGNORE_NAME);
  writeIfChanged(baseFile, surface);

  if (wroteCanon || wroteLive) {
    const allow = surface.permissions?.allow;
    const count = Array.isArray(allow) ? allow.length : 0;
    console.error(`syncGlobalPermissions: synced ${count} global allow rules between ~/.claude and worm`);
  }
}

main();
