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
echo "check-changelog: ${version} has an entry"
