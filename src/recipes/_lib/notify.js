// Shared OS-notification helper for worm's recipe scripts (autosync, notify).
// NOT a recipe itself — just packaged code under dist/recipes/ that sibling
// scripts import. Picks the best available backend and never throws (a failed
// notification must never break a hook).
//
//   notify({ title, message, sound?, focusPath? })
//
// macOS: prefers `terminal-notifier` (supports a click action — focusing the VS
// Code window for `focusPath`), else falls back to `osascript`. Linux: `notify-send`.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function findTerminalNotifier() {
  for (const p of ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]) {
    if (existsSync(p)) return p;
  }
  const which = spawnSync("which", ["terminal-notifier"], { encoding: "utf8" });
  return which.status === 0 && which.stdout.trim() ? "terminal-notifier" : null;
}

export function notify({ title, message, sound = false, focusPath = "" } = {}) {
  try {
    if (process.platform === "darwin") {
      const tn = findTerminalNotifier();
      if (tn) {
        const args = ["-title", title, "-message", message];
        if (sound) args.push("-sound", "default");
        // Clicking raises the existing VS Code window rooted at focusPath (no new
        // tab) — `open -a` goes through LaunchServices, reliable from the notifier.
        if (focusPath) args.push("-execute", `open -a "Visual Studio Code" '${focusPath}'`);
        else args.push("-activate", "com.microsoft.VSCode");
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
