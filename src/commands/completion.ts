import { WormError } from "../utils/errors.js";

/**
 * Emit a shell completion script for `worm`. Designed to be sourced from
 * the user's rc file:
 *
 *   eval "$(worm completion zsh)"   # or bash
 *
 * The scripts complete:
 *   - Subcommand names (static list).
 *   - Branch names for `warp` (via `git for-each-ref`).
 *   - Currently-active branch names + slot indices for `collapse` / `cd` /
 *     `tp` / `path` (via `git worktree list --porcelain`). Listing only
 *     active refs keeps suggestions valid — a non-warped branch / free slot
 *     would error if completed.
 *   - Config keys for `config`.
 */
export function runCompletion(shell: string | undefined): void {
  if (!shell) {
    throw new WormError("Missing shell argument.", {
      hint: "Usage: worm completion <bash|zsh>",
    });
  }
  const normalized = shell.toLowerCase();
  if (normalized === "bash") {
    process.stdout.write(BASH);
    return;
  }
  if (normalized === "zsh") {
    process.stdout.write(ZSH);
    return;
  }
  throw new WormError(`Unsupported shell: ${shell}.`, {
    hint: "Supported: bash, zsh.",
  });
}

const COMMANDS = [
  "init",
  "clone",
  "warp",
  "collapse",
  "status",
  "universes",
  "cd",
  "tp",
  "path",
  "config",
  "destroy",
  "shell-init",
  "completion",
];

// `warp` mounts a branch into a fresh slot — only branches are valid.
const BRANCH_ONLY_COMMANDS = ["warp"];
// `collapse`/`cd`/`tp`/`path` all flow through `worm path`'s resolver, which
// accepts either a branch name or a 0-based slot index.
const REF_COMMANDS = ["collapse", "cd", "tp", "path"];
const CONFIG_KEYS = ["editor"];

const BASH = `# worm bash completion. Source with: eval "$(worm completion bash)"
_worm_complete() {
  local cur prev cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${COMMANDS.join(" ")}" -- "$cur"))
    return
  fi

  case "$cmd" in
    ${BRANCH_ONLY_COMMANDS.join("|")})
      local branches
      branches="$(git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)"
      COMPREPLY=($(compgen -W "$branches" -- "$cur"))
      ;;
    ${REF_COMMANDS.join("|")})
      local refs wtlist
      wtlist="$(git worktree list --porcelain 2>/dev/null)"
      refs="$(printf '%s\\n' "$wtlist" | sed -nE 's|^branch refs/heads/||p;')
$(printf '%s\\n' "$wtlist" | sed -nE 's|^worktree .*-uni([0-9]+)$|\\1|p;')"
      COMPREPLY=($(compgen -W "$refs" -- "$cur"))
      ;;
    config)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=($(compgen -W "${CONFIG_KEYS.join(" ")}" -- "$cur"))
      fi
      ;;
    completion)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=($(compgen -W "bash zsh" -- "$cur"))
      fi
      ;;
  esac
}
complete -F _worm_complete worm
`;

const ZSH = `# worm zsh completion. Source with: eval "$(worm completion zsh)"
# Make sure zsh's completion system is loaded — \`compdef\` is only available
# after \`compinit\` runs, and we can't rely on the user's rc ordering.
if ! type compdef >/dev/null 2>&1; then
  autoload -Uz compinit && compinit
fi

_worm_complete() {
  local -a _worm_commands _worm_branches
  _worm_commands=(${COMMANDS.map((c) => `'${c}'`).join(" ")})

  if (( CURRENT == 2 )); then
    compadd -- $_worm_commands
    return
  fi

  case "\${words[2]}" in
    ${BRANCH_ONLY_COMMANDS.join("|")})
      _worm_branches=(\${(f)"$(git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)"})
      compadd -- $_worm_branches
      ;;
    ${REF_COMMANDS.join("|")})
      local _worm_wtlist
      _worm_wtlist="$(git worktree list --porcelain 2>/dev/null)"
      compadd -- \${(f)"$(printf '%s\\n' "$_worm_wtlist" | sed -nE 's|^branch refs/heads/||p;')"}
      compadd -- \${(f)"$(printf '%s\\n' "$_worm_wtlist" | sed -nE 's|^worktree .*-uni([0-9]+)$|\\1|p;')"}
      ;;
    config)
      if (( CURRENT == 3 )); then
        compadd -- ${CONFIG_KEYS.map((k) => `'${k}'`).join(" ")}
      fi
      ;;
    completion)
      if (( CURRENT == 3 )); then
        compadd -- bash zsh
      fi
      ;;
  esac
}
compdef _worm_complete worm
`;
