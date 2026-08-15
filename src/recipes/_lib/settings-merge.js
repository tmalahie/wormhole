// Three-way merge for Claude settings files, shared by BOTH sync recipes:
//   - `syncGlobalPermissions` → machine-wide ~/.claude/settings.json ↔ the
//     git-tracked canonical copy at ~/.worm/shared/.claude/settings.json
//   - `syncPermissions`       → a slot's .claude/settings.local.json ↔ the
//     per-project canonical copy in the profile
// Plain ESM, copied verbatim to dist/recipes/ by tsup and imported by the sibling
// workers over a relative path — never bundled, so it stays dependency-free.
//
// The merge is RECURSIVE, so a conflict costs a LEAF and never a subtree:
//   - arrays  → three-way set merge: an element present in the base survives only
//               if it's still on BOTH sides (so removing it from EITHER file
//               propagates); an element absent from the base is kept if EITHER
//               side added it (so approvals flow across slots/machines).
//   - objects → recurse per key, so two sides that add DIFFERENT keys both win.
//               This is the whole point of the recursion: an opaque
//               last-edited-wins on an object silently discards the loser's keys.
//   - scalars → the side that diverged from the base wins; if BOTH diverged, the
//               more-recently-edited file wins (`liveNewer`). The only lossy case.
// With no base yet (first run, or a newly synced key) every rule degrades to a
// union — the merge can't lose data before it has an ancestor to reason about.
import fs from "node:fs";
import path from "node:path";

export const jkey = (value) => JSON.stringify(value ?? null);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const kindOf = (v) => (Array.isArray(v) ? "array" : isPlainObject(v) ? "object" : "scalar");

/** Three-way set merge over the elements of three arrays. Preserves order: base
 *  elements first (in base order), then live-only additions, then canon-only. */
export function mergeSet(base = [], live = [], canon = []) {
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

/** Three-way resolution for a value no structural rule can express (a scalar, or
 *  a value whose TYPE changed between sides). The side that diverged from the
 *  base wins; if both diverged, the more-recently edited file wins. */
export function mergeScalar(base, live, canon, liveNewer) {
  const changedLive = jkey(live) !== jkey(base);
  const changedCanon = jkey(canon) !== jkey(base);
  if (changedLive && changedCanon) return liveNewer ? live : canon;
  if (changedLive) return live;
  if (changedCanon) return canon;
  // Neither diverged (or no base): prefer whichever value actually exists.
  return live !== undefined ? live : canon !== undefined ? canon : base;
}

/**
 * Recursively three-way merge one value. `undefined` means "absent on this side"
 * both going in and coming out — a caller drops the key when the result is
 * `undefined`, which is how a deletion propagates.
 */
export function merge3(base, live, canon, liveNewer) {
  // A side that dropped the value outright while the other left it at the base is
  // an unambiguous deletion. (If the other side ALSO edited it, we fall through
  // and recurse instead — a delete-vs-modify resolves toward keeping the edit.)
  if (base !== undefined) {
    if (live === undefined && jkey(canon) === jkey(base)) return undefined;
    if (canon === undefined && jkey(live) === jkey(base)) return undefined;
  }

  const present = [base, live, canon].filter((v) => v !== undefined);
  if (present.length === 0) return undefined;
  const kinds = new Set(present.map(kindOf));
  // Mixed shapes (a value that changed type between sides) can't be merged
  // structurally — fall back to picking a whole side.
  if (kinds.size !== 1) return mergeScalar(base, live, canon, liveNewer);

  const [kind] = kinds;
  if (kind === "scalar") return mergeScalar(base, live, canon, liveNewer);
  if (kind === "array") return mergeSet(base ?? [], live ?? [], canon ?? []);

  const out = {};
  const keys = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(live ?? {}),
    ...Object.keys(canon ?? {}),
  ]);
  for (const key of keys) {
    const merged = merge3(base?.[key], live?.[key], canon?.[key], liveNewer);
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

// --- the key set -------------------------------------------------------------

export const WILDCARD = "*";

// Keys the `"*"` wildcard does NOT sweep up, because syncing them is a decision
// worth making deliberately rather than inheriting:
//   - `env` is where an API key or credential would live, and the canonical copy
//     is committed and pushed by autosync.
//   - `trustedDirectories` records a per-machine "I vetted this checkout" answer;
//     replaying it elsewhere skips the prompt that exists to ask it.
// Naming one alongside the wildcard (`["*", "env"]`) opts it back in, since an
// explicitly named key is never filtered.
export const WILDCARD_DENY = ["env", "trustedDirectories"];

/**
 * Resolve a configured key list against the files being merged. Without the
 * wildcard the list is used as-is; with it, every top-level key found on any
 * `source` joins the set except the denylisted ones. Expanded HERE rather than at
 * wiring time because only the worker can see the live files — so a key added to
 * the settings file starts syncing without a re-wire.
 */
export function expandKeys(configured, sources, deny = WILDCARD_DENY) {
  const named = configured.filter((key) => key !== WILDCARD);
  if (named.length === configured.length) return named; // no wildcard
  const keys = new Set(named);
  for (const src of sources) {
    if (!src) continue;
    for (const key of Object.keys(src)) {
      if (!deny.includes(key)) keys.add(key);
    }
  }
  return [...keys];
}

// --- worm-managed hook entries ----------------------------------------------
// worm OWNS the hook entries it wired (`worm hook trigger …`): `worm sync` /
// `worm sync --global` strip and re-add them from config on every run. Syncing
// them as well would give that block two writers that undo each other — a machine
// that hasn't re-synced yet looks like it DELETED them, the 3-way propagates that
// removal, and the next `worm sync` puts them back, forever. So `hooks` syncs the
// USER's own entries only: worm's are split off before the merge and re-attached
// to the live file after, and the canonical copy never holds them.

// Kept in sync with DISPATCH_MARKER in src/core/recipes.ts (this script is
// standalone and can't import it).
const DISPATCH_MARKER = "hook trigger ";

const isWormHookEntry = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes(DISPATCH_MARKER));

/**
 * Split a settings `hooks` block into `[user, worm]`, preserving the per-event
 * arrays. Either half is `undefined` when it holds nothing, so it merges as an
 * absent key rather than an empty object.
 */
export function splitWormHooks(hooks) {
  if (!isPlainObject(hooks)) return [undefined, undefined];
  const user = {};
  const worm = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      user[event] = entries; // not a shape we recognise — treat it as the user's
      continue;
    }
    const mine = entries.filter((entry) => !isWormHookEntry(entry));
    const theirs = entries.filter(isWormHookEntry);
    if (mine.length > 0) user[event] = mine;
    if (theirs.length > 0) worm[event] = theirs;
  }
  return [
    Object.keys(user).length > 0 ? user : undefined,
    Object.keys(worm).length > 0 ? worm : undefined,
  ];
}

/**
 * Re-attach worm's own entries to a merged user-hooks block. The order matches
 * `writeHooksFile` in src/core/recipes.ts (user entries first, worm's appended)
 * so the two writers agree on the result and neither rewrites the other's output.
 */
export function withWormHooks(userHooks, wormHooks) {
  const out = {};
  for (const event of new Set([...Object.keys(userHooks ?? {}), ...Object.keys(wormHooks ?? {})])) {
    const merged = [...(userHooks?.[event] ?? []), ...(wormHooks?.[event] ?? [])];
    if (merged.length > 0) out[event] = merged;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- file helpers ------------------------------------------------------------

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function mtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return -Infinity;
  }
}

export function writeIfChanged(filePath, value) {
  const content = JSON.stringify(value, null, 2) + "\n";
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

/**
 * Overlay a merged surface onto a live settings object: every synced key is
 * replaced by its merged value, and DELETED when the merge resolved to absent.
 * Keys outside the surface are left untouched. `overrides` supplies a different
 * value for the live file than the canonical one (used by `hooks`, where the
 * live file also carries worm's own entries).
 */
export function applySurface(live, keys, surface, overrides = {}) {
  const out = { ...live };
  for (const key of keys) {
    const value = key in overrides ? overrides[key] : surface[key];
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}
