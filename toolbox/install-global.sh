#!/usr/bin/env bash
set -euo pipefail

mode="${1:---check}"
if (( $# > 1 )) || [[ "$mode" != --check && "$mode" != --install ]]; then
  printf 'usage: %s [--check|--install]\n' "$0" >&2
  exit 2
fi

if [[ -n "${MISE_GLOBAL_CONFIG_FILE:-}" ]]; then
  printf 'MISE_GLOBAL_CONFIG_FILE overrides conf.d; unset it before using this installer\n' >&2
  exit 2
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_file="$source_dir/mise.toml"
if [[ -n "${MISE_CONFIG_DIR:-}" ]]; then
  config_dir="$MISE_CONFIG_DIR"
else
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mise"
fi
target_dir="$config_dir/conf.d"
target="$target_dir/coding-agent-tools.toml"

if [[ -L "$target" ]]; then
  printf 'refusing to replace a symlink: %s\n' "$target" >&2
  exit 2
fi

if [[ "$mode" == --check ]]; then
  if [[ -f "$target" ]] && cmp -s "$source_file" "$target"; then
    printf 'global agent-tool config is current: %s\n' "$target"
    exit 0
  fi
  printf 'global agent-tool config missing or drifted: %s\n' "$target" >&2
  exit 1
fi

if ! command -v mise >/dev/null 2>&1; then
  printf 'mise is not installed; install mise before using --install\n' >&2
  exit 2
fi

# This script owns only its named fragment, not the user's config.toml or
# other conf.d files. Do not overwrite unrelated content occupying that name.
if [[ -e "$target" ]] && ! grep -Fxq \
  '# Managed by coding-tooling agent tools; use toolbox/install-global.sh to refresh a global copy.' \
  "$target"; then
  printf 'refusing to overwrite unmanaged global config: %s\n' "$target" >&2
  exit 2
fi

if [[ ! -f "$target" ]] || ! cmp -s "$source_file" "$target"; then
  mkdir -p "$target_dir"
  staged="$(mktemp "$target_dir/.coding-agent-tools.toml.XXXXXXXX")"
  trap 'rm -f -- "$staged"' EXIT
  cp "$source_file" "$staged"
  chmod 0644 "$staged"
  mv -f -- "$staged" "$target"
  trap - EXIT
  printf 'updated global agent-tool config: %s\n' "$target"
else
  printf 'global agent-tool config already current: %s\n' "$target"
fi

# Install only this fragment's tools, not unrelated toolchains declared by a
# project or the user's other global files. mise's own install is idempotent.
temporary_dir="$(mktemp -d)"
trap 'rmdir -- "$temporary_dir"' EXIT
MISE_GLOBAL_CONFIG_FILE="$target" mise -C "$temporary_dir" install
