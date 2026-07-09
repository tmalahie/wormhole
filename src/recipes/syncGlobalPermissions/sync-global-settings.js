#!/usr/bin/env node
// The `syncGlobalPermissions` recipe's worker, shipped WITH worm. The GLOBAL
// analogue of the per-project `syncPermissions` recipe: keeps a configurable set
// of top-level keys of the user-level ~/.claude/settings.json (default:
// `permissions` + `sandbox`) in step with a git-tracked canonical copy in the
// worm repo, so those settings are version-controlled (and synced across machines
// once autosync pushes them). The key set is passed as CLI args by the recipe
// wiring, e.g. `node sync-global-settings.js permissions sandbox env tui`.
//
// The live global file can't be a symlink into worm — Claude's permission dialog
// edits it in place — hence this copy-and-merge. IMPORTANT: the live file also
// holds hooks / marketplaces / trustedDirectories; we only ever touch
// `permissions` and `sandbox`, never the whole file. The canonical copy holds
// `{permissions, sandbox}` — the version-tracked surface — so the rest of the
// global config stays local and untracked.
//
// Conflict resolution is a THREE-WAY merge against a machine-local "base"
// snapshot (`~/.worm/.sync-global-settings.base.json`, gitignored) recording the
// synced surface as of the last run — the common ancestor:
//   - permission arrays (allow/deny/ask): a rule present in the base survives only
//     if it's still on BOTH sides (so removing it from EITHER file propagates); a
//     rule absent from the base is kept if EITHER side added it (so approvals still
//     flow across slots/machines). No base yet → falls back to a plain union, which
//     never loses a rule.
//   - scalar keys (permissions.defaultMode, the whole `sandbox` block): the side
//     that changed vs the base wins; if BOTH changed, the more-recently-edited file
//     (by mtime) wins. This is the "last edited file is the source of truth" rule,
//     scoped to values a set-union can't express.
// After merging, both files AND the base snapshot are rewritten to the result, so
// the next run has an up-to-date ancestor.
//
// Invoked by the GLOBAL dispatch (`worm hook trigger --global <session-start|stop|
// session-end>`). Ignores stdin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function mtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return -Infinity;
  }
}

const jkey = (value) => JSON.stringify(value ?? null);

// Three-way set merge over the elements of three arrays. Preserves order: base
// elements first (in base order), then live-only additions, then canon-only.
function mergeSet(base = [], live = [], canon = []) {
  const inLive = new Set(live.map(jkey));
  const inCanon = new Set(canon.map(jkey));
  const inBase = new Set(base.map(jkey));
  const keep = (k) => (inBase.has(k) ? inLive.has(k) && inCanon.has(k) : inLive.has(k) || inCanon.has(k));

  const out = [];
  const emitted = new Set();
  for (const value of [...base, ...live, ...canon]) {
    const k = jkey(value);
    if (emitted.has(k)) continue;
    if (keep(k)) {
      emitted.add(k);
      out.push(value);
    }
  }
  return out;
}

// Three-way resolution for a value a set-union can't express (scalar / object).
// The side that diverged from the base wins; if both diverged, the more-recently
// edited file wins.
function mergeScalar(base, live, canon, liveNewer) {
  const changedLive = jkey(live) !== jkey(base);
  const changedCanon = jkey(canon) !== jkey(base);
  if (changedLive && changedCanon) return liveNewer ? live : canon;
  if (changedLive) return live;
  if (changedCanon) return canon;
  // Neither diverged (or no base): prefer whichever value actually exists.
  return live !== undefined ? live : canon !== undefined ? canon : base;
}

function mergePermissions(base = {}, live = {}, canon = {}, liveNewer) {
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(live), ...Object.keys(canon)]);
  for (const key of keys) {
    const b = base[key];
    const l = live[key];
    const c = canon[key];
    if (Array.isArray(l) || Array.isArray(c) || Array.isArray(b)) {
      out[key] = mergeSet(
        Array.isArray(b) ? b : [],
        Array.isArray(l) ? l : [],
        Array.isArray(c) ? c : []
      );
    } else {
      const merged = mergeScalar(b, l, c, liveNewer);
      if (merged !== undefined) out[key] = merged;
    }
  }
  return out;
}

function writeIfChanged(filePath, content) {
  let current = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch {
    // missing
  }
  if (current === content) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

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

// `hooks` is never synced (belt-and-suspenders with the config schema): worm owns
// it per-machine and it carries machine-specific absolute paths.
const NEVER_SYNC = new Set(["hooks"]);
// The two structured blocks worm has always synced, regardless of mode.
const ALWAYS_SYNC = ["permissions", "sandbox"];
// Explicit key set from CLI args (recipe config `keys`), else auto mode.
const EXPLICIT_KEYS = process.argv.slice(2).filter((k) => !NEVER_SYNC.has(k));

// A value cheap enough to overwrite wholesale: string/number/boolean/null. Arrays
// and objects are structural (env, extraKnownMarketplaces, trustedDirectories, …)
// and stay machine-local unless named explicitly.
const isPrimitive = (v) => v === null || typeof v !== "object";

// Resolve which top-level keys to sync this run. Explicit config wins; otherwise
// AUTO mode = permissions + sandbox + every top-level primitive-valued key found
// on either side (so scalar prefs like effortLevel/tui sync with zero config,
// while structural keys stay local).
function syncedKeys(live, canon, base) {
  if (EXPLICIT_KEYS.length) return EXPLICIT_KEYS;
  const keys = new Set(ALWAYS_SYNC);
  for (const src of [live, canon, base]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (NEVER_SYNC.has(k) || ALWAYS_SYNC.includes(k)) continue;
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

  // The synced surface: each key three-way-merged. `permissions` gets the nested
  // set/scalar merge; every other key is merged as an opaque value (last-edited-
  // file wins), matching how `sandbox` has always behaved.
  const surface = {};
  for (const key of syncedKeys(live, canon, base)) {
    if (key === "permissions") {
      surface.permissions = mergePermissions(base.permissions, live.permissions, canon.permissions, liveNewer);
    } else {
      const merged = mergeScalar(base[key], live[key], canon[key], liveNewer);
      if (merged !== undefined) surface[key] = merged;
    }
  }
  const mergedPermissions = surface.permissions || {};

  // Canonical holds only the tracked surface (the configured keys); the live file
  // keeps every other key untouched, with only that surface overwritten.
  const wroteCanon = writeIfChanged(canonicalFile, JSON.stringify(surface, null, 2) + "\n");
  const wroteLive = writeIfChanged(
    liveFile,
    JSON.stringify({ ...live, ...surface }, null, 2) + "\n"
  );
  // Advance the 3-way ancestor to the state both files now hold.
  ensureIgnored(BASE_IGNORE_NAME);
  writeIfChanged(baseFile, JSON.stringify(surface, null, 2) + "\n");

  if (wroteCanon || wroteLive) {
    const count = Array.isArray(mergedPermissions.allow) ? mergedPermissions.allow.length : 0;
    console.error(`syncGlobalPermissions: synced ${count} global allow rules between ~/.claude and worm`);
  }
}

main();
