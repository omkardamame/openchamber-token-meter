#!/usr/bin/env bash
# Fail if a commit or a working file carries a credential.
#
# Runs before every `stable`, and any time a secret is suspected. It looks for
# the shapes credentials actually take, plus the live OpenCode password when
# this machine can read it, so a leak of *this* machine's token is caught too.
set -euo pipefail
cd "$(dirname "$0")/.."

SHAPES='ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJhbGciOi[A-Za-z0-9_-]{20,}'
hits=0

report() {
  hits=1
  printf 'SECRET?  %s\n' "$1"
}

# 1. Every blob ever committed, so a deleted secret that still lives in history is caught.
while read -r blob _; do
  [ "$(git cat-file -t "$blob" 2>/dev/null || true)" = blob ] || continue
  # Piped, not captured: the package now holds PNGs, and a captured binary
  # blob makes bash warn about null bytes on every run.
  if git cat-file -p "$blob" 2>/dev/null | grep -aqE "$SHAPES"; then
    report "history: blob $blob"
  fi
done <<< "$(git rev-list --objects --all)"

# 2. The working tree, so an uncommitted file cannot slip into the next commit.
while IFS= read -r file; do
  grep -qE "$SHAPES" "$file" && report "working tree: $file"
done <<< "$(git ls-files --cached --others --exclude-standard)"

# 3. This machine's live OpenCode password, when the process exposes it.
pw=$(ps eww -Ao pid,command 2>/dev/null | grep -o 'OPENCODE_PASSWORD=[^ ]*' | head -1 | cut -d= -f2- || true)
if [ -n "${pw:-}" ]; then
  if git rev-list --objects --all | awk '{print $1}' | while read -r blob; do
      [ "$(git cat-file -t "$blob" 2>/dev/null || true)" = blob ] || continue
      git cat-file -p "$blob" | grep -aqF "$pw" && echo "$blob"
    done | grep -q .; then
    report 'history: the live OpenCODE_PASSWORD appears in a commit'
  fi
fi

if [ "$hits" -ne 0 ]; then
  echo 'secret-scan: FAILED — remove the value and rewrite the commit before pushing.' >&2
  exit 1
fi
echo "secret-scan: clean ($(git rev-list --count HEAD) commits, $(git ls-files | wc -l | tr -d ' ') tracked files)"
