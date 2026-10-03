// worm-vscode — one VS Code window per worm project, pointed at whichever
// worktree you are working in.
//
// The window is opened from the project's `<p>.code-workspace` (written by
// `worm sync` in the profile, next to slots.json). Focusing a worktree swaps
// folder 0 with `updateWorkspaceFolders` — no window reload, the extension host
// restarts (~1.5 s). The control plane drives it through a URI:
//
//   vscode://tmalahie.worm-vscode/focus?workspace=<abs .code-workspace>&path=<abs worktree>
//
// URIs reach whichever window is focused, so a window acts only when the URI
// names *its* workspace file; any other window ignores it. A misrouted click
// then does nothing instead of taking over the wrong window.
//
// Never writes settings. Inert in any window not opened from a worm workspace.
const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const git = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout));
  });

/** The workspace file, when this window was opened from a worm profile's one. */
function wormWorkspace() {
  const file = vscode.workspace.workspaceFile;
  if (!file || file.scheme !== 'file' || !file.fsPath.endsWith('.code-workspace')) return null;
  const profileDir = path.dirname(file.fsPath);
  if (!fs.existsSync(path.join(profileDir, 'config.json'))) return null;
  return { file: file.fsPath, profileDir };
}

/** The repo's main worktree, from folder 0 (whichever worktree it shows). */
async function repoRoot() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  const common = (await git(folder.uri.fsPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return common ? path.dirname(common) : null;
}

async function listWorktrees() {
  const root = await repoRoot();
  if (!root) return [];
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, prunable: false };
      list.push(cur);
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
  }
  return list
    .filter((w) => !w.prunable)
    .map((w) => ({ ...w, name: w.path === root ? 'main' : path.basename(w.path), isMain: w.path === root }));
}

/** worktree path → slot, from the profile's slots.json (written by worm). */
function readSlots(ws) {
  const map = new Map();
  try {
    const table = JSON.parse(fs.readFileSync(path.join(ws.profileDir, 'slots.json'), 'utf8'));
    for (const [n, e] of Object.entries(table)) if (e?.worktree) map.set(path.resolve(e.worktree), Number(n));
  } catch {
    /* no slots yet */
  }
  return map;
}

const label = (w) => w.branch ?? w.name;

const inside = (file, root) => file === root || file.startsWith(root + path.sep);

/** Editor tabs showing a file under `root` (text and diff editors). */
function tabsUnder(root) {
  const found = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tab.input?.uri ?? tab.input?.modified;
      if (uri?.scheme === 'file' && inside(uri.fsPath, root)) found.push({ tab, group, uri });
    }
  }
  return found;
}

/**
 * Switch the window to another worktree — and take the open files along.
 *
 * Left alone, the tabs would keep pointing at the old worktree's copies, which
 * is the other branch's code: the next edit lands in the wrong worktree. So the
 * old worktree's tabs are closed and the same relative paths reopened from the
 * new one (a file the other branch does not have is just dropped). Unsaved
 * changes stop the switch until they are saved or discarded.
 *
 * All of it happens before the folder swap: swapping folder 0 restarts the
 * extension host, and nothing after it is guaranteed to run.
 *
 * Outside a worm workspace, swapping folders would turn the window into an
 * "Untitled (Workspace)", so the worktree is opened as a plain folder instead.
 */
async function focus(wt) {
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const n = vscode.workspace.workspaceFolders?.length ?? 0;
  if (current === wt.path && n === 1) return true;
  if (!wormWorkspace()) {
    return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceReuseWindow: true });
  }
  if (current && current !== wt.path && n === 1) {
    const old = tabsUnder(current);
    const dirty = old.filter((t) => t.tab.isDirty);
    if (dirty.length) {
      const choice = await vscode.window.showWarningMessage(
        `${dirty.length} file${dirty.length > 1 ? 's have' : ' has'} unsaved changes in ${path.basename(current)}.`,
        { modal: true },
        'Save all and switch',
      );
      if (choice !== 'Save all and switch') return false;
      await vscode.workspace.saveAll(false);
    }
    const reopen = old
      .map(({ uri, group, tab }) => ({ target: path.join(wt.path, path.relative(current, uri.fsPath)), column: group.viewColumn, active: tab.isActive && group.isActive }))
      .filter((r) => fs.existsSync(r.target));
    await vscode.window.tabGroups.close(old.map((t) => t.tab), true);
    // Active one last, so it ends up focused.
    reopen.sort((a, b) => Number(a.active) - Number(b.active));
    for (const r of reopen) {
      await vscode.window.showTextDocument(vscode.Uri.file(r.target), { viewColumn: r.column, preview: false, preserveFocus: !r.active });
    }
  }
  return vscode.workspace.updateWorkspaceFolders(0, n, { uri: vscode.Uri.file(wt.path), name: label(wt) });
}

async function pick(placeHolder) {
  const ws = wormWorkspace();
  const slots = ws ? readSlots(ws) : new Map();
  const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const items = (await listWorktrees()).map((w) => ({
    label: `${w.path === current ? '$(check) ' : ''}${label(w)}`,
    description: [w.isMain ? 'main' : w.name, slots.has(w.path) ? `slot ${slots.get(w.path)}` : null].filter(Boolean).join(' · '),
    detail: w.path,
    wt: w,
  }));
  return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true }))?.wt;
}

/**
 * Language servers a previous extension host left behind.
 *
 * Swapping folder 0 restarts the extension host, and some extensions' servers
 * outlive it — oxc's `oxlint --lsp` does, one orphan (~40 MB) per switch. This
 * host's own server is our sibling's child; the leftovers were re-parented to
 * launchd (ppid 1). Only those, and only ones running from this repo's
 * node_modules (main checkout or a worktree under it), are stopped.
 */
async function reapOrphanServers() {
  const root = await repoRoot();
  if (!root) return 0;
  const out = await new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
  });
  let reaped = 0;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || m[2] !== '1') continue;
    const args = m[3];
    if (!/\boxlint\b.*--lsp\b/.test(args)) continue;
    if (!args.includes(`${root}/node_modules/`) && !args.includes(`${root}/.claude/worktrees/`)) continue;
    try {
      process.kill(Number(m[1]), 'SIGTERM');
      reaped += 1;
    } catch {
      /* already gone */
    }
  }
  return reaped;
}

function activate(context) {
  const ws = wormWorkspace();
  if (ws) reapOrphanServers().catch(() => {});
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'worm.focusWorktree';

  const refresh = async () => {
    if (!wormWorkspace()) return status.hide();
    const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wt = (await listWorktrees()).find((w) => w.path === current);
    if (!wt) return status.hide();
    const slot = readSlots(ws).get(wt.path);
    status.text = `$(git-branch) ${label(wt)}${slot === undefined ? '' : ` · slot ${slot}`}`;
    status.tooltip = `${wt.path}\nClick to focus another worktree`;
    status.show();
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('worm.focusWorktree', async (target) => {
      const wt = typeof target === 'string' ? (await listWorktrees()).find((w) => w.path === path.resolve(target)) : await pick('Focus a worktree');
      if (wt) focus(wt);
    }),
    vscode.commands.registerCommand('worm.showAllWorktrees', async () => {
      if (!wormWorkspace()) {
        return vscode.window.showWarningMessage('worm: Show All Worktrees needs a window opened from a worm project workspace.');
      }
      const all = await listWorktrees();
      const n = vscode.workspace.workspaceFolders?.length ?? 0;
      vscode.workspace.updateWorkspaceFolders(0, n, ...all.map((w) => ({ uri: vscode.Uri.file(w.path), name: label(w) })));
    }),
    vscode.commands.registerCommand('worm.refreshWorktrees', refresh),
    vscode.commands.registerCommand('worm.openTerminalInWorktree', async () => {
      const wt = await pick('Open a terminal in…');
      if (wt) vscode.window.createTerminal({ name: label(wt), cwd: wt.path }).show();
    }),
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        if (uri.path !== '/focus') return;
        const q = new URLSearchParams(uri.query);
        const mine = wormWorkspace();
        // Not ours: the URI landed in whichever window had focus. Ignore it.
        if (!mine || path.resolve(q.get('workspace') ?? '') !== mine.file) return;
        const target = path.resolve(q.get('path') ?? '');
        const wt = (await listWorktrees()).find((w) => w.path === target);
        if (wt) focus(wt);
        else vscode.window.showWarningMessage(`worm: ${target} is not a worktree of this project`);
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  );
  const timer = setInterval(refresh, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  refresh();
}

module.exports = { activate, deactivate() {} };
