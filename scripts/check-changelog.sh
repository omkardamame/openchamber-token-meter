#!/usr/bin/env bash
# Every release carries its entry: the CHANGELOG must have a heading for the
# version in package.json, or a `stable` would ship without a note.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
if ! grep -qE "^## \[${version//./\\.}\]" CHANGELOG.md; then
  echo "check-changelog: CHANGELOG.md has no entry for ${version}" >&2
  exit 1
fi
# A heading with nothing under it is not a release note, and gh-release refuses
# it later; fail here, where the gate can see it.
section=$(awk -v v="## [${version}]" 'index($0,v)==1 {found=1; next} found && /^## \[/ {exit} found {print}' CHANGELOG.md)
if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "check-changelog: the ${version} section is empty" >&2
  exit 1
fi
echo "check-changelog: ${version} has an entry"
