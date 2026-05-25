/**
 * Emit a shell function the user can eval in their .zshrc / .bashrc:
 *
 *   eval "$(worm shell-init)"
 *
 * Once installed, `worm cd <branch>` and `worm tp <N>` actually change the
 * shell's cwd. Everything else passes through to the binary as normal.
 */
export function runShellInit(): void {
  process.stdout.write(SHELL_FUNCTION);
}

const SHELL_FUNCTION = `\
worm() {
  case "$1" in
    cd|tp)
      shift
      local _worm_path
      _worm_path="$(command worm path "$@")" || return $?
      builtin cd -- "$_worm_path"
      ;;
    *)
      command worm "$@"
      ;;
  esac
}
`;
