#!/usr/bin/env bash
set -euo pipefail

# mise registry key : executable name. Checking the executable itself catches
# missing backends even when a mise shim happens to be present on PATH.
tools=(
  jq:jq
  ripgrep:rg
  fd:fd
  gh:gh
  yq:yq
  shellcheck:shellcheck
  shfmt:shfmt
  actionlint:actionlint
  hyperfine:hyperfine
  uv:uv
  just:just
  bat:bat
)

failed=0
for entry in "${tools[@]}"; do
  name="${entry%%:*}"
  executable="${entry#*:}"
  if ! command -v "$executable" >/dev/null 2>&1; then
    printf 'agent tool unavailable: %s (executable %s)\n' "$name" "$executable" >&2
    failed=1
  elif ! "$executable" --version >/dev/null 2>&1; then
    printf 'agent tool cannot run: %s (executable %s)\n' "$name" "$executable" >&2
    failed=1
  fi
done

if (( failed != 0 )); then
  exit 1
fi
printf '%s agent tools ready\n' "${#tools[@]}"
