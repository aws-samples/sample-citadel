#!/usr/bin/env bash
# Test suite for scripts/check-allowlist-expiry.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-allowlist-expiry.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT

pass=0
fail=0

run_test() {
  local name="$1"
  shift
  echo -n "  TEST: $name ... "
  if "$@"; then
    echo "PASS"
    pass=$((pass + 1))
  else
    echo "FAIL"
    fail=$((fail + 1))
  fi
}

# ── Test 1: all future dates → exit 0 ──
test_all_future() {
  local f="$TMPDIR_BASE/all-future.md"
  cat > "$f" <<'MD'
## GHSA-xxxx — example
**Added: 2026-09-30** | **revisitBy: 2099-12-31**
**Recommended follow-ups (revisitBy: 2099-06-15):**
MD
  local out exit_code=0
  out=$("$SCRIPT" "$f" "2026-10-01") || exit_code=$?
  [[ "$exit_code" -eq 0 ]] || return 1
  [[ "$out" == *"2 revisitBy date(s)"* ]] || return 1
  [[ "$out" == *"All revisitBy dates are in the future"* ]] || return 1
}

# ── Test 2: one expired → exit 1 and names it ──
test_one_expired() {
  local f="$TMPDIR_BASE/one-expired.md"
  cat > "$f" <<'MD'
## GHSA-aaaa
**Added: 2026-09-30** | **revisitBy: 2026-10-01**
## GHSA-bbbb
**Recommended follow-ups (revisitBy: 2099-01-01):**
MD
  local out exit_code=0
  out=$("$SCRIPT" "$f" "2026-10-11") || exit_code=$?
  [[ "$exit_code" -eq 1 ]] || return 1
  [[ "$out" == *"EXPIRED"* ]] || return 1
  [[ "$out" == *"2026-10-01"* ]] || return 1
  [[ "$out" == *"1 expired"* ]] || return 1
}

# ── Test 3: zero dates found → exit 2 ──
test_zero_dates() {
  local f="$TMPDIR_BASE/no-dates.md"
  cat > "$f" <<'MD'
# Some markdown file
No revisit dates here at all.
MD
  local out exit_code=0
  out=$("$SCRIPT" "$f" "2026-10-01") || exit_code=$?
  [[ "$exit_code" -eq 2 ]] || return 1
  [[ "$out" == *"Zero revisitBy dates found"* ]] || return 1
}

# ── Test 4: real file today → exit 0, prints 7 entries ──
test_real_file() {
  local real="$REPO_ROOT/audit-ci-allowlist-justifications.md"
  if [[ ! -f "$real" ]]; then
    echo "SKIP (real file not found)"
    pass=$((pass + 1))
    return 0
  fi
  local out exit_code=0
  # Use a date far enough in the past that none expire but the intro line is skipped
  # Actually use today's override far in the past so all are future
  out=$("$SCRIPT" "$real" "2026-01-01") || exit_code=$?
  [[ "$exit_code" -eq 0 ]] || return 1
  # Count the "revisitBy" lines in output (OK lines + any expired)
  local count
  count=$(echo "$out" | grep -c 'revisitBy [0-9]') || true
  # The real file has 7 revisitBy lines, but 1 is the intro paragraph
  # which lacks a date after the keyword — so we expect 6
  # Let's check: lines 51, 88, 116, 133, 145, 157 have dates; line 6 does not
  [[ "$count" -eq 6 ]] || { echo "(expected 6 dated entries, got $count)"; return 1; }
}

# ── Test 5: expired-on-today (boundary) → exit 1 ──
test_expired_on_today() {
  local f="$TMPDIR_BASE/today-boundary.md"
  cat > "$f" <<'MD'
**revisitBy: 2026-10-11**
MD
  local out exit_code=0
  out=$("$SCRIPT" "$f" "2026-10-11") || exit_code=$?
  [[ "$exit_code" -eq 1 ]] || return 1
  [[ "$out" == *"EXPIRED"* ]] || return 1
}

# ── Test 6: missing file → exit 2 ──
test_missing_file() {
  local out exit_code=0
  out=$("$SCRIPT" "$TMPDIR_BASE/nonexistent.md" "2026-10-01" 2>&1) || exit_code=$?
  [[ "$exit_code" -eq 2 ]] || return 1
}

echo "Running check-allowlist-expiry.sh tests..."
echo ""
run_test "all future dates → exit 0" test_all_future
run_test "one expired → exit 1, names it" test_one_expired
run_test "zero dates → exit 2" test_zero_dates
run_test "real file → exit 0, 6 dated entries" test_real_file
run_test "expired on today boundary → exit 1" test_expired_on_today
run_test "missing file → exit 2" test_missing_file

echo ""
echo "Results: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
