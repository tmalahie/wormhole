#!/usr/bin/env node
// SessionStart/SessionEnd hook shipped WITH worm (syncPermissions recipe).
// Bidirectionally unions the 'permissions' block of this slot's
// .claude/settings.local.json with a canonical store shared by every slot, so
// approving a command in one slot teaches them all. ONLY 'permissions' is
// synced — 'hooks' and any other keys (e.g. the sandbox recipe's) are preserved
// untouched in each file, so recipes share settings.local.json without clobber.
//
// This file is config-independent: the canonical store is passed at run time, so
// ONE copy lives in the worm package (dist/recipes/) and is never materialized
// per project.
//
// Usage:  node sync-claude-settings.js <canonicalFile>
//   - the worktree file is <CLAUDE_PROJECT_DIR>/.claude/settings.local.json
//   - a one-line summary is logged under $WORM_LOG_DIR (defaults to ../../logs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const canonicalFile = process.argv[2];
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const worktreeFile = path.join(projectDir, '.claude', 'settings.local.json');
if (!canonicalFile) process.exit(0);

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function unionArrays(a, b) {
  const seen = new Set();
  const out = [];
  for (const value of [].concat(a || [], b || [])) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) { seen.add(key); out.push(value); }
  }
  return out;
}

function mergePermissions(canon, local) {
  canon = canon || {};
  local = local || {};
  const out = Object.assign({}, canon);
  for (const key of new Set([].concat(Object.keys(canon), Object.keys(local)))) {
    const cv = canon[key];
    const lv = local[key];
    if (Array.isArray(cv) || Array.isArray(lv)) {
      out[key] = unionArrays(Array.isArray(cv) ? cv : [], Array.isArray(lv) ? lv : []);
    } else if (cv === undefined) {
      out[key] = lv;
    }
  }
  return out;
}

function writeIfChanged(filePath, obj) {
  const content = JSON.stringify(obj, null, 2) + '\n';
  let current = null;
  try { current = fs.readFileSync(filePath, 'utf8'); } catch (e) {}
  if (current === content) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

const canon = readJson(canonicalFile) || {};
const local = readJson(worktreeFile) || {};
const merged = mergePermissions(canon.permissions, local.permissions);
if (Object.keys(merged).length === 0) process.exit(0); // nothing to sync yet

// Merge-preserving: keep each file's other keys, sync only 'permissions'.
const wroteLocal = writeIfChanged(worktreeFile, Object.assign({}, local, { permissions: merged }));
const wroteCanon = writeIfChanged(canonicalFile, Object.assign({}, canon, { permissions: merged }));
if (wroteLocal || wroteCanon) {
  try {
    const logDir = process.env.WORM_LOG_DIR || path.join(__dirname, '..', '..', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const n = Array.isArray(merged.allow) ? merged.allow.length : 0;
    const line = '[' + new Date().toISOString() + '] synced ' + n + ' allow rules (' + worktreeFile + ')\n';
    fs.appendFileSync(path.join(logDir, 'sync-permissions.log'), line);
  } catch (e) { /* logging is best-effort */ }
}
