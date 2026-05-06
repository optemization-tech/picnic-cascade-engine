#!/usr/bin/env bash
# Migrate a single study end-to-end with auto-recovery for the
# silent-Inception partial-failure mode (PR #98 detection + runbook recovery).
#
# Usage:
#   ./scripts/batch-migrate/migrate-with-recovery.sh <study-key>
#
# Behavior:
#   1. Run the orchestrator (full pipeline: create Production Study → Inception
#      → consolidate → Migrator).
#   2. Check Activity Log for the latest Inception entry on this study.
#   3. If Failed (Batch incomplete): run the runbook recovery
#      (delete + clear audit + reInception), then re-fire Migrator with
#      --skip-create-study --skip-inception.
#   4. Print a single-line summary.
#
# Exit codes:
#   0 = clean migration (with or without auto-recovery)
#   1 = recovery failed or unrecoverable orchestrator error

set -uo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <study-key>" >&2
  exit 1
fi
STUDY=$1

cd "$(dirname "$0")/../.." || exit 1  # cd to engine repo root

echo
echo "================================================================"
echo "  migrate-with-recovery: $STUDY  ($(date -u +%H:%M:%S)Z)"
echo "================================================================"

# Step 1: orchestrator (full pipeline)
echo
echo "[1/3] Run orchestrator (full pipeline)"
node scripts/batch-migrate/batch-migrate.js --study "$STUDY"
ORCH_EXIT=$?
if [ $ORCH_EXIT -ne 0 ]; then
  echo "Orchestrator failed with exit $ORCH_EXIT" >&2
  exit 1
fi

# Step 2: check Inception Activity Log
echo
echo "[2/3] Check Activity Log for Inception status"
node scripts/batch-migrate/check-inception.js --study "$STUDY"
CHECK_EXIT=$?

case $CHECK_EXIT in
  0)
    echo "✓ Inception Success — no recovery needed"
    ;;
  1)
    echo "⚠ Inception Failed (Batch incomplete) — running recovery..."
    echo
    echo "[3/3] Recover (runbook procedure)"
    node scripts/batch-migrate/recover-inception.js --study "$STUDY"
    REC_EXIT=$?
    if [ $REC_EXIT -ne 0 ]; then
      echo "Recovery failed with exit $REC_EXIT — escalate" >&2
      exit 1
    fi
    echo
    echo "[3b] Re-fire Migrator on full cascade state"
    node scripts/batch-migrate/batch-migrate.js --study "$STUDY" --skip-create-study --skip-inception
    if [ $? -ne 0 ]; then
      echo "Migrator re-fire failed" >&2
      exit 1
    fi
    ;;
  *)
    echo "check-inception returned exit $CHECK_EXIT — investigate" >&2
    exit 1
    ;;
esac

echo
echo "✓ $STUDY complete  ($(date -u +%H:%M:%S)Z)"
exit 0
