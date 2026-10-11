#!/usr/bin/env bash
# check-allowlist-expiry.sh — Fail CI when any revisitBy date in the
# audit-ci allowlist justifications file has expired (or when zero dates
# are found, which means the regex drifted and the check is a no-op).
#
# Usage:  scripts/check-allowlist-expiry.sh <path-to-allowlist.md> [today-override]
#   path-to-allowlist.md   Path to the audit-ci-allowlist-justifications.md file.
#   today-override         Optional YYYY-MM-DD to use as "today" (for tests).
#
# Exit codes:
#   0 — all dates are in the future
#   1 — one or more dates are expired (::error:: lines emitted)
#   2 — zero revisitBy dates found (silent no-match must never pass)
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <path-to-allowlist.md> [today-override]" >&2
  exit 2
fi

file="$1"
today="${2:-$(date -u +%Y-%m-%d)}"

if [[ ! -f "$file" ]]; then
  echo "::error::File not found: $file"
  exit 2
fi

# Validate today is YYYY-MM-DD
if ! [[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "::error::Invalid today override: $today (must be YYYY-MM-DD)"
  exit 2
fi

found=0
expired=0

# Extract revisitBy dates in all observed formats:
#   **Recommended follow-ups (revisitBy: 2026-10-22):**
#   **revisitBy: 2026-11-30**
#   **Added: 2026-09-30** | **revisitBy: 2026-11-30**
#   revisitBy: 2026-10-22
#   | revisitBy | 2026-10-22 |  (table cells)
# Strategy: match any line containing "revisitBy" (case-insensitive) then
# pull the first YYYY-MM-DD that follows the keyword on that line.
while IFS= read -r line; do
  # Skip lines that are purely descriptive (e.g., "renew by the revisitBy date")
  # by requiring a date to actually follow the keyword.
  date=""
  # Extract: everything after "revisitBy" on the line, then grab the first date
  after_keyword="${line#*revisitBy}"
  # Also handle mixed case
  if [[ "$after_keyword" == "$line" ]]; then
    after_keyword="${line#*revisitby}"
  fi
  if [[ "$after_keyword" == "$line" ]]; then
    after_keyword="${line#*REVISITBY}"
  fi

  # Try to extract YYYY-MM-DD from what follows the keyword
  if [[ "$after_keyword" =~ ([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
    date="${BASH_REMATCH[1]}"
  fi

  if [[ -z "$date" ]]; then
    continue
  fi

  # Validate date format (basic: month 01-12, day 01-31)
  if ! [[ "$date" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$ ]]; then
    echo "::warning::Skipping malformed date: $date"
    continue
  fi

  found=$((found + 1))

  if [[ "$date" < "$today" || "$date" == "$today" ]]; then
    echo "::error::EXPIRED revisitBy $date — $line"
    expired=$((expired + 1))
  else
    echo "  OK  revisitBy $date — $line"
  fi
done < <(grep -i 'revisitBy' "$file" || true)

echo ""
echo "Found $found revisitBy date(s), $expired expired."

if [[ "$found" -eq 0 ]]; then
  echo "::error::Zero revisitBy dates found in $file — regex may have drifted. Failing loudly."
  exit 2
fi

if [[ "$expired" -gt 0 ]]; then
  echo "One or more allowlist justifications have expired. Review and renew them."
  exit 1
fi

echo "All revisitBy dates are in the future."
exit 0
