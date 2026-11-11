#!/usr/bin/env bash
# What the next `stable` should be called — or `none` when nothing ships.
#
# A release is for changes that affect the application: the frames, the service,
# the shared modules, or the extension manifest. Docs, README, comments, tooling
# and other non-behavioural edits are committed and pushed without a version
# bump and without a tag.
#
#   scripts/next-version.sh          v1.2.3, or none
#   scripts/next-version.sh 2.0.0    the owner named it; that wins
#   scripts/next-version.sh --why    what it counted
set -euo pipefail
cd "$(dirname "$0")/.."

last=$(git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)
base=${last#v}
IFS=. read -r major minor patch <<< "$base"

shipped=$(git diff --name-only "${last}..HEAD" -- panel status service shared | wc -l | tr -d ' ')
manifest=$(git diff "${last}..HEAD" -- package.json | grep -c '^[+-].*"openchamber"' || true)
subjects=$(git log --format=%s "${last}..HEAD" 2>/dev/null || true)
breaking=$(printf '%s\n' "$subjects" | grep -cE '^breaking(\(|:|!)|^[a-z]+(\([^)]*\))?!:' || true)
features=$(printf '%s\n' "$subjects" | grep -cE '^feat(\(|:)' || true)
commits=$(printf '%s\n' "$subjects" | grep -c . || true)

if [ "${1:-}" = '--why' ]; then
  printf 'last tag: %s\ncommits since: %s (breaking %s, features %s)\n' "$last" "$commits" "$breaking" "$features"
  printf 'app files changed: %s, manifest lines changed: %s\n' "$shipped" "$manifest"
  [ -n "$subjects" ] && printf '%s\n' "$subjects" | sed 's/^/  /'
  exit 0
fi

if [ -n "${1:-}" ]; then
  case "$1" in
    v[0-9]*) printf '%s\n' "$1" ;;
    [0-9]*) printf 'v%s\n' "$1" ;;
    *) echo "next-version: '$1' is not a version" >&2; exit 2 ;;
  esac
  exit 0
fi

if [ "$shipped" -eq 0 ] && [ "${manifest:-0}" -eq 0 ]; then
  echo none
  exit 0
fi

if [ "$breaking" -gt 0 ]; then
  printf 'v%d.0.0\n' "$((major + 1))"
elif [ "$features" -gt 0 ]; then
  printf 'v%d.%d.0\n' "$major" "$((minor + 1))"
else
  printf 'v%d.%d.%d\n' "$major" "$minor" "$((patch + 1))"
fi
