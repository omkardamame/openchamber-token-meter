#!/usr/bin/env bash
# The whole gate in one run, with the slow independent suites in parallel.
#
# A step counts only when its own exit code says so: nothing here reads an
# output to decide whether it passed. Build first, alone, because every suite
# runs the built files; then price (binds nothing), collector (47821/47829) and
# page (41873), recording integration (ephemeral port) and recording storage
# together, since their ports do not overlap; then the two scans,
# one after the other, so they never read a file while a suite is writing.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="${TMPDIR:-/tmp}"
failed=()
logs=()

cleanup() {
  [ "${#logs[@]}" -eq 0 ] || rm -f "${logs[@]}"
}
trap cleanup EXIT

section() {
  printf '\n=== %s ===\n' "$1"
}

# One name and one code: the run fails as a whole if any step is not zero.
record() {
  [ "$2" -eq 0 ] || failed+=("$1 (exit $2)")
}

# A step with its output on screen: the scans print a line worth reading.
run_step() {
  local name=$1
  shift
  section "$name"
  local code=0
  "$@" || code=$?
  record "$name" "$code"
}

# A failed build leaves the suites testing the previous bundle, so it stops the
# run instead of reporting a green on stale files.
section 'build'
code=0
bun run build || code=$?
if [ "$code" -ne 0 ]; then
  printf '\nverify: FAILED — build exited %s\n' "$code"
  exit 1
fi

run_step 'check' bun run check

# Ports are per run so two gates (or a stale suite) can overlap safely.
export PAGE_TEST_PORT="${PAGE_TEST_PORT:-$((41000 + ($$ % 900)))}"
export COLLECTOR_TEST_PORT="${COLLECTOR_TEST_PORT:-$((43000 + ($$ % 900)))}"

# ---- the independent suites, together ------------------------------------
suites=(price collector page recording recording-store)
codes=()
pids=()
for name in "${suites[@]}"; do
  log="$tmp/token-meter-$name-$$.log"
  logs+=("$log")
  node "scripts/$name-test.mjs" >"$log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  code=0
  wait "$pid" || code=$?
  codes+=("$code")
done

# Printed afterwards, in a fixed order: the slow suite no longer hides the
# fast ones' failures, and a read never races another suite's write.
for index in "${!suites[@]}"; do
  name="${suites[$index]}"
  section "$name"
  cat "$tmp/token-meter-$name-$$.log"
  record "$name" "${codes[$index]}"
done

# ---- the file scans, one at a time ----------------------------------------
run_step 'secret-scan' bash scripts/secret-scan.sh
run_step 'secret-scan-test' bash scripts/secret-scan-test.sh
run_step 'check-changelog' bash scripts/check-changelog.sh

if [ "${#failed[@]}" -ne 0 ]; then
  printf '\nverify: FAILED\n'
  for entry in "${failed[@]}"; do
    printf '  - %s\n' "$entry"
  done
  exit 1
fi

printf '\nverify: every step passed\n'
