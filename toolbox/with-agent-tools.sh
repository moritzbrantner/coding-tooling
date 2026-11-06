#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  printf 'usage: %s COMMAND [ARG ...]\n' "$0" >&2
  exit 2
fi

shims="${MISE_SHIMS_DIR:-${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims}"
if [[ ! -d "$shims" ]]; then
  printf 'mise shims missing at %s; run toolbox/install-global.sh --install first\n' "$shims" >&2
  exit 2
fi

# Supply fallback commands without shadowing an existing project toolchain.
# Each shim resolves its tool version from the directory where it is invoked.
case ":${PATH:-}:" in
  *":$shims:"*) ;;
  *) export PATH="${PATH:+$PATH:}$shims" ;;
esac
exec -- "$@"
