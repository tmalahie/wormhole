#!/usr/bin/env node
// SessionStart/SessionEnd hook shipped WITH worm (syncPermissions recipe).
// Keeps this slot's .claude/settings.local.json in step with a canonical store
// shared by every slot of the project, so approving a command in one slot teaches
// them all. Only the CONFIGURED keys are touched (default: `permissions`) — every
// other key is preserved untouched in each file, so recipes can share
// settings.local.json without clobbering each other.
//
// The merge is the same recursive THREE-WAY merge the global recipe uses
// (../_lib/settings-merge.js), against a machine-local per-slot base snapshot —
// so a rule you REVOKE in one slot propagates instead of being resurrected by the
// union on the next session (which is what the old union-only merge did). With no
// base yet the merge degrades to that same union, so a first run can't lose data.
//
// This file is config-independent: the canonical store and base snapshot are
// passed at run time, so ONE copy lives in the worm package (dist/recipes/) and is
// never materialized per project.
//
// Usage:  node sync-claude-settings.js <canonicalFile> <baseFile> [keys...]
//   - keys default to `permissions`; `"*"` syncs every top-level key except the
//     denylist in ../_lib/settings-merge.js
//   - the worktree file is <CLAUDE_PROJECT_DIR>/.claude/settings.local.json
//   - a one-line summary is logged under $WORM_LOG_DIR (defaults to ../../logs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySurface,
  expandKeys,
  merge3,
  mtime,
  readJson,
  splitWormHooks,
  withWormHooks,
  writeIfChanged,
} from '../_lib/settings-merge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const canonicalFile = process.argv[2];
const baseFile = process.argv[3];
const configuredKeys = process.argv.slice(4);
if (!configuredKeys.length) configuredKeys.push('permissions');
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const worktreeFile = path.join(projectDir, '.claude', 'settings.local.json');
if (!canonicalFile || !baseFile) process.exit(0);

// The per-slot base snapshots are machine-local (they hold this machine's
// divergence, and every machine has a slot called `main`), so keep them out of
// the ~/.worm git repo. init.ts owns the canonical .gitignore list; this mirrors
// the global recipe's guard for installs that predate the entry.
const BASE_IGNORE_PATTERN = 'projects/*/.sync-permissions.base.*.json';
function ensureIgnored() {
  const wormHome =
    process.env.WORM_HOME && process.env.WORM_HOME.trim()
      ? path.resolve(process.env.WORM_HOME)
      : path.join(os.homedir(), '.worm');
  const gitignore = path.join(wormHome, '.gitignore');
  let current = '';
  try {
    current = fs.readFileSync(gitignore, 'utf8');
  } catch {
    return; // not a git-tracked worm home; nothing to guard
  }
  if (current.split(/\r?\n/).includes(BASE_IGNORE_PATTERN)) return;
  fs.writeFileSync(gitignore, current.replace(/\n?$/, '\n') + BASE_IGNORE_PATTERN + '\n');
}

// Nothing worth materializing a settings.local.json for: every synced key is
// absent or an empty container.
const isEmptySurface = (surface) =>
  Object.values(surface).every(
    (v) => v === undefined || (typeof v === 'object' && v !== null && Object.keys(v).length === 0)
  );

const canon = readJson(canonicalFile) || {};
const local = readJson(worktreeFile) || {};
const base = readJson(baseFile) || {};
const localNewer = mtime(worktreeFile) >= mtime(canonicalFile);
// `"*"` is expanded here, not at wiring time — only this side sees the files.
const keys = expandKeys(configuredKeys, [local, canon, base]);

// `hooks` (only synced when named in `keys`) merges on its USER-owned entries
// only — worm's own per-slot dispatch entries are re-attached afterwards.
const [localUserHooks, localWormHooks] = splitWormHooks(local.hooks);
const [canonUserHooks] = splitWormHooks(canon.hooks);
const [baseUserHooks] = splitWormHooks(base.hooks);

const surface = {};
const localOverrides = {};
for (const key of keys) {
  if (key === 'hooks') {
    const merged = merge3(baseUserHooks, localUserHooks, canonUserHooks, localNewer);
    if (merged !== undefined) surface.hooks = merged;
    const attached = withWormHooks(merged, localWormHooks);
    if (attached !== undefined) localOverrides.hooks = attached;
    continue;
  }
  const merged = merge3(base[key], local[key], canon[key], localNewer);
  if (merged !== undefined) surface[key] = merged;
}
if (isEmptySurface(surface)) process.exit(0); // nothing to sync yet

// Merge-preserving: keep each file's other keys, sync only the configured ones.
const wroteLocal = writeIfChanged(worktreeFile, applySurface(local, keys, surface, localOverrides));
const wroteCanon = writeIfChanged(canonicalFile, applySurface(canon, keys, surface));
// Advance the 3-way ancestor to the state both files now hold.
ensureIgnored();
writeIfChanged(baseFile, surface);

if (wroteLocal || wroteCanon) {
  try {
    const logDir = process.env.WORM_LOG_DIR || path.join(__dirname, '..', '..', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const n = Array.isArray(surface.permissions?.allow) ? surface.permissions.allow.length : 0;
    const line = '[' + new Date().toISOString() + '] synced ' + n + ' allow rules (' + worktreeFile + ')\n';
    fs.appendFileSync(path.join(logDir, 'sync-permissions.log'), line);
  } catch (e) { /* logging is best-effort */ }
}
