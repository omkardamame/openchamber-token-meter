#!/usr/bin/env bash
# Proves the credential guard actually fails: a scanner that reports clean
# without looking is worse than none. Builds throwaway repositories under
# $TMPDIR, sets a fake OpenCode password in this process's environment (so
# `ps eww` exposes it exactly as the real one is), and runs a copy of the
# scanner from inside each repository.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/secret-scan-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

export OPENCODE_PASSWORD='AUDITfakePasswordValue1234567890'
export GIT_AUTHOR_NAME=audit GIT_AUTHOR_EMAIL=audit@example.invalid
export GIT_COMMITTER_NAME=audit GIT_COMMITTER_EMAIL=audit@example.invalid

fail=0
check() {
  if [ "$2" -eq "$3" ]; then printf 'PASS  %s\n' "$1"; else printf 'FAIL  %s (exit %s, wanted %s)\n' "$1" "$2" "$3"; fail=1; fi
}

fresh_repo() {
  local dir="$tmp/$1"
  mkdir -p "$dir/scripts"
  cp "$root/scripts/secret-scan.sh" "$dir/scripts/"
  git -C "$dir" init -q
  printf 'read me\n' > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -qm 'init'
  printf '%s\n' "$dir"
}

run_scan() {
  local code=0
  ( cd "$1" && bash scripts/secret-scan.sh >/dev/null 2>&1 ) || code=$?
  printf '%s' "$code"
}

clean=$(fresh_repo clean)
check 'a clean repository passes' "$(run_scan "$clean")" 0

shaped=$(fresh_repo shaped)
printf 'token sk-ant-api03-%s\n' 'abcdefghijklmnopqrstuvwxyz012345' > "$shaped/notes.md"
git -C "$shaped" add notes.md && git -C "$shaped" commit -qm 'key shape'
check 'a committed modern key shape fails' "$(run_scan "$shaped")" 1

untracked=$(fresh_repo untracked)
printf 'value=%s\n' "$OPENCODE_PASSWORD" > "$untracked/notes-untracked.md"
check 'an uncommitted file with the live password fails' "$(run_scan "$untracked")" 1

history=$(fresh_repo history)
printf 'value=%s\n' "$OPENCODE_PASSWORD" > "$history/notes.md"
git -C "$history" add notes.md && git -C "$history" commit -qm 'leak'
git -C "$history" rm -q notes.md && git -C "$history" commit -qm 'remove'
check 'a deleted password still in history fails' "$(run_scan "$history")" 1

notrepo="$tmp/not-repo"
mkdir -p "$notrepo/scripts"
cp "$root/scripts/secret-scan.sh" "$notrepo/scripts/"
check 'outside a repository the scan refuses to claim clean' "$(run_scan "$notrepo")" 2

if [ "$fail" -ne 0 ]; then
  echo 'secret-scan-test: FAILED'
  exit 1
fi
echo 'secret-scan-test: 5/5 checks passed'
