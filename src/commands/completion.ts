import { WormError } from "../utils/errors.js";

/**
 * Emit a shell completion script for `worm`. Source from your rc file:
 *
 *   eval "$(worm completion zsh)"   # or bash
 *
 * Completes subcommand names, and worktree names + checked-out branches for
 * `cd` / `path` (via `git worktree list --porcelain`).
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
  "worktree",
  "slot",
  "sync",
  "wire",
  "detach",
  "status",
  "cd",
  "path",
  "destroy",
  "shell-init",
  "completion",
];

// `cd`/`path` flow through `worm path`'s resolver: a worktree name, a branch or a slot.
const REF_COMMANDS = ["cd", "path"];

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
    ${REF_COMMANDS.join("|")})
      local refs wtlist
      wtlist="$(git worktree list --porcelain 2>/dev/null)"
      refs="$(printf '%s\\n' "$wtlist" | sed -nE 's|^branch refs/heads/||p;')
main
$(printf '%s\\n' "$wtlist" | sed -nE 's|^worktree .*/\\.claude/worktrees/([^/]+)$|\\1|p;')"
      COMPREPLY=($(compgen -W "$refs" -- "$cur"))
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
  local -a _worm_commands
  _worm_commands=(${COMMANDS.map((c) => `'${c}'`).join(" ")})

  if (( CURRENT == 2 )); then
    compadd -- $_worm_commands
    return
  fi

  case "\${words[2]}" in
    ${REF_COMMANDS.join("|")})
      local _worm_wtlist
      _worm_wtlist="$(git worktree list --porcelain 2>/dev/null)"
      compadd -- \${(f)"$(printf '%s\\n' "$_worm_wtlist" | sed -nE 's|^branch refs/heads/||p;')"}
      compadd -- main \${(f)"$(printf '%s\\n' "$_worm_wtlist" | sed -nE 's|^worktree .*/\\.claude/worktrees/([^/]+)$|\\1|p;')"}
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
