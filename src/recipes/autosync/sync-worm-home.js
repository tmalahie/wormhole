#!/usr/bin/env node
// The autosync recipe's worker, shipped WITH worm. Invoked by the GLOBAL hook
// dispatch (`worm hook trigger --global <session-start|stop|session-end>`, wired
// into ~/.claude/settings.json by `worm sync --global`). Keeps the ~/.worm
// meta-repo synced across machines — pull on session start, push (debounced) on
// each turn's Stop, flush on session end.
//
// Config-independent worm-owned code: ONE copy lives in dist/recipes/, never
// materialized per project. It always acts on ~/.worm (WORM_HOME or the default),
// regardless of which session triggered it.
//
// Usage:  node sync-worm-home.js <remote> <debounceMinutes> <notify 0|1> <pull|push>
//
// Conflicts are NEVER auto-resolved: a clean `git rebase --abort` restores the
// repo, then a durable marker (.autosync-conflict.json, surfaced by `worm
// status`) plus an OS notification tell the human. The next clean sync clears it.
// Always exits 0 — a sync hiccup must never block a session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const remote = process.argv[2] || "origin";
const debounceMin = Number(process.argv[3] || "0");
const notify = process.argv[4] === "1";
const mode = process.argv[5]; // "pull" | "push"

const home =
  process.env.WORM_HOME && process.env.WORM_HOME.trim()
    ? path.resolve(process.env.WORM_HOME)
    : path.join(os.homedir(), ".worm");

// Kept in sync with src/core/paths.ts (AUTOSYNC_CONFLICT_FILE_NAME).
const CONFLICT_FILE = path.join(home, ".autosync-conflict.json");
const STAMP_FILE = path.join(home, ".autosync-last-push");

function git(args) {
  return spawnSync("git", ["-C", home, ...args], { encoding: "utf8" });
}

function isRepo() {
  return fs.existsSync(path.join(home, ".git"));
}

function currentBranch() {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function clearConflict() {
  try {
    fs.unlinkSync(CONFLICT_FILE);
  } catch {
    // not present — fine
  }
}

function recordConflict(detail) {
  try {
    fs.writeFileSync(
      CONFLICT_FILE,
      JSON.stringify(
        { at: new Date().toISOString(), machine: os.hostname(), mode, remote, detail },
        null,
        2
      ) + "\n"
    );
  } catch {
    // best effort
  }
  console.error(`autosync: CONFLICT — ${detail}. ~/.worm left clean; resolve by hand.`);
  notifyUser("worm autosync conflict", `${detail}. Run: cd ${home} && git status`);
}

function notifyUser(title, message) {
  if (!notify) return;
  try {
    if (process.platform === "darwin") {
      spawnSync("osascript", [
        "-e",
        `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
      ]);
    } else if (process.platform === "linux") {
      spawnSync("notify-send", [title, message]);
    }
  } catch {
    // notifications are best-effort
  }
}

/**
 * Integrate the remote branch by rebasing onto it (autostash for any local edits).
 * Returns true when in sync (or there's nothing remote to integrate yet); false
 * when it hit a conflict — in which case it has already aborted cleanly and
 * recorded the marker.
 */
function integrate(branch) {
  git(["fetch", remote, branch]);
  const ref = `${remote}/${branch}`;
  if (git(["rev-parse", "--verify", "--quiet", ref]).status !== 0) {
    return true; // remote branch doesn't exist yet — nothing to integrate
  }
  if (git(["rebase", "--autostash", ref]).status === 0) return true;
  git(["rebase", "--abort"]);
  recordConflict(`rebase onto ${ref} hit conflicts`);
  return false;
}

function debounced() {
  if (!debounceMin) return false;
  try {
    const ageMin = (Date.now() - fs.statSync(STAMP_FILE).mtimeMs) / 60000;
    return ageMin < debounceMin;
  } catch {
    return false;
  }
}

function stamp() {
  try {
    fs.writeFileSync(STAMP_FILE, "");
  } catch {
    // best effort
  }
}

function commitIfDirty() {
  git(["add", "-A"]);
  // `diff --cached --quiet` exits 1 when there ARE staged changes.
  if (git(["diff", "--cached", "--quiet"]).status === 0) return;
  git(["commit", "--quiet", "-m", `worm autosync ${new Date().toISOString()} on ${os.hostname()}`]);
}

function main() {
  if (!mode || !isRepo()) return;
  if (git(["remote", "get-url", remote]).status !== 0) {
    console.log(`autosync: no remote "${remote}" on ${home}; skipping.`);
    return;
  }
  const branch = currentBranch();
  if (!branch) {
    console.log("autosync: detached HEAD; skipping.");
    return;
  }

  if (mode === "pull") {
    if (integrate(branch)) clearConflict();
    return;
  }

  // push
  if (debounced()) return;
  commitIfDirty();
  if (git(["push", remote, branch]).status === 0) {
    clearConflict();
    stamp();
    return;
  }
  // Push rejected (diverged) — integrate, then retry once.
  if (!integrate(branch)) return; // conflict: marker written, repo restored
  if (git(["push", remote, branch]).status === 0) {
    clearConflict();
    stamp();
  }
}

try {
  main();
} catch (err) {
  console.error(`autosync: unexpected error: ${String(err)}`);
}
process.exit(0);
