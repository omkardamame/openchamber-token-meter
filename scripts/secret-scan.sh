#!/usr/bin/env bash
# Fail if a commit or a working file carries a credential.
#
# Runs before every `stable`, and any time a secret is suspected. It looks for
# the shapes credentials actually take, plus the live OpenCode password when
# this machine can read it, so a leak of *this* machine's token is caught in
# history and in uncommitted files too.
set -euo pipefail
cd "$(dirname "$0")/.."

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo 'secret-scan: not a git repository — nothing was scanned' >&2
  exit 2
}

SHAPES='ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJhbGciOi[A-Za-z0-9_-]{20,}'
hits=0

report() {
  hits=1
  printf 'SECRET?  %s\n' "$1"
}

# Every live OpenCode password this machine exposes (normally one). A short
# value is a shell fragment, not a credential, and would match every file.
pws=$(ps eww -Ao pid,command 2>/dev/null | grep -o 'OPENCODE_PASSWORD=[^ ]*' | cut -d= -f2- | awk 'length($0) >= 16' | sort -u || true)

# One list, read in this shell (not through a pipe): with `pipefail`, a loop
# piped into `grep -q` reports the loop's last iteration, so a real hit in an
# earlier blob was missed.
blobs=$(git rev-list --objects --all | awk '{print $1}')

# 1. Every blob ever committed, so a deleted secret that still lives in history
#    is caught, plus this machine's live password wherever it appears.
while read -r blob; do
  [ -n "$blob" ] || continue
  [ "$(git cat-file -t "$blob" 2>/dev/null || true)" = blob ] || continue
  # Piped, not captured: the package holds PNGs, and a captured binary blob
  # makes bash warn about null bytes on every run.
  if git cat-file -p "$blob" 2>/dev/null | grep -aqE "$SHAPES"; then
    report "history: blob $blob"
  fi
  while IFS= read -r pw; do
    [ -n "$pw" ] || continue
    if git cat-file -p "$blob" 2>/dev/null | grep -aqF "$pw"; then
      report 'history: the live OPENCODE_PASSWORD appears in a commit'
      break 2
    fi
  done <<< "$pws"
done <<< "$blobs"

# 2. The working tree, so an uncommitted file cannot slip into the next commit.
while IFS= read -r file; do
  [ -f "$file" ] || continue
  grep -qE "$SHAPES" "$file" && report "working tree: $file"
  while IFS= read -r pw; do
    [ -n "$pw" ] || continue
    if grep -qF "$pw" "$file"; then
      report "working tree: $file (live OpenCODE_PASSWORD)"
      break
    fi
  done <<< "$pws"
done <<< "$(git ls-files --cached --others --exclude-standard)"

if [ "$hits" -ne 0 ]; then
  echo 'secret-scan: FAILED — remove the value and rewrite the commit before pushing.' >&2
  exit 1
fi
echo "secret-scan: clean ($(git rev-list --count HEAD) commits, $(git ls-files | wc -l | tr -d ' ') tracked files)"
