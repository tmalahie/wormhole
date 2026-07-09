// Shared OS-notification helper for worm's recipe scripts (autosync, notify).
// NOT a recipe itself — just packaged code under dist/recipes/ that sibling
// scripts import. Picks the best available backend and never throws (a failed
// notification must never break a hook).
//
//   notify({ title, message, sound?, focusPath?, focusApp? })
//
// macOS: prefers `terminal-notifier` (supports a click action — opening
// `focusPath` in `focusApp`, e.g. focusing the editor window for that folder),
// else falls back to `osascript`. Linux: `notify-send`. `focusApp` is a macOS
// application name (e.g. "Visual Studio Code", "Cursor"); empty → no click action.
import { existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Wrap a value in single quotes for safe interpolation into a shell command,
// escaping any embedded single quote as the standard '\'' sequence.
function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function findTerminalNotifier() {
  for (const p of ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]) {
    if (existsSync(p)) return p;
  }
  const which = spawnSync("which", ["terminal-notifier"], { encoding: "utf8" });
  return which.status === 0 && which.stdout.trim() ? "terminal-notifier" : null;
}

export function notify({ title, message, sound = false, focusPath = "", focusApp = "" } = {}) {
  try {
    // Test seam: when WORM_NOTIFY_SINK is set, record the payload instead of
    // firing a real OS notification. Lets the suite assert whether (and with
    // what) a notification would have fired without popping toasts during a run.
    // Unset in normal use, so this is a no-op in production.
    if (process.env.WORM_NOTIFY_SINK) {
      appendFileSync(
        process.env.WORM_NOTIFY_SINK,
        JSON.stringify({ title, message, sound, focusPath, focusApp }) + "\n"
      );
      return;
    }
    if (process.platform === "darwin") {
      const tn = findTerminalNotifier();
      if (tn) {
        const args = ["-title", title, "-message", message];
        if (sound) args.push("-sound", "default");
        // Clicking opens focusPath in focusApp — for a folder-based editor (VS
        // Code, Cursor, Windsurf…) `open -a` raises the existing window rooted at
        // that folder (no new tab). Skipped when either is unset → plain notification.
        // terminal-notifier runs `-execute` through a shell, so single-quote both
        // values (a path/app name may legally contain spaces or even a quote, e.g.
        // ~/git/o'brien) — otherwise the click action breaks or mis-parses.
        if (focusApp && focusPath) {
          args.push("-execute", `open -a ${shQuote(focusApp)} ${shQuote(focusPath)}`);
        }
        spawnSync(tn, args, { stdio: "ignore" });
        return;
      }
      const sndClause = sound ? ' sound name "default"' : "";
      spawnSync(
        "osascript",
        ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${sndClause}`],
        { stdio: "ignore" }
      );
      return;
    }
    if (process.platform === "linux") {
      spawnSync("notify-send", [title, message], { stdio: "ignore" });
    }
  } catch {
    // notifications are strictly best-effort
  }
}
