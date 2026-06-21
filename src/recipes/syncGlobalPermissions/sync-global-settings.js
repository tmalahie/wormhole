#!/usr/bin/env node
// The `syncGlobalPermissions` recipe's worker, shipped WITH worm. The GLOBAL
// analogue of the per-project `syncPermissions` recipe: bidirectionally unions the
// `permissions` block of the user-level ~/.claude/settings.json with a git-tracked
// canonical copy in the worm repo, so global allow/deny rules are version-
// controlled (and synced across machines once autosync pushes them).
//
// The live global file can't be a symlink into worm — Claude's permission dialog
// edits it in place — hence this copy-and-merge. IMPORTANT: the live file also
// holds hooks / marketplaces / trustedDirectories; we replace ONLY `permissions`,
// never the whole file. The canonical copy holds ONLY `{permissions}` so the rest
// of the global config stays local and untracked.
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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function unionArrays(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const value of [...a, ...b]) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function mergePermissions(canon = {}, local = {}) {
  const out = { ...canon };
  for (const key of new Set([...Object.keys(canon), ...Object.keys(local)])) {
    const canonValue = canon[key];
    const localValue = local[key];
    if (Array.isArray(canonValue) || Array.isArray(localValue)) {
      out[key] = unionArrays(
        Array.isArray(canonValue) ? canonValue : [],
        Array.isArray(localValue) ? localValue : []
      );
    } else if (canonValue === undefined) {
      out[key] = localValue;
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

function main() {
  const live = readJson(liveFile);
  if (live === null) return; // no global settings file — nothing to sync
  const canon = readJson(canonicalFile) || {};

  const mergedPermissions = mergePermissions(canon.permissions, live.permissions);

  // Canonical holds ONLY permissions (the tracked, git-diffable surface); the live
  // file keeps every other key untouched, with only its permissions block updated.
  const wroteCanon = writeIfChanged(
    canonicalFile,
    JSON.stringify({ permissions: mergedPermissions }, null, 2) + "\n"
  );
  const wroteLive = writeIfChanged(
    liveFile,
    JSON.stringify({ ...live, permissions: mergedPermissions }, null, 2) + "\n"
  );

  if (wroteCanon || wroteLive) {
    const count = Array.isArray(mergedPermissions.allow) ? mergedPermissions.allow.length : 0;
    console.error(`syncGlobalPermissions: synced ${count} global allow rules between ~/.claude and worm`);
  }
}

main();
