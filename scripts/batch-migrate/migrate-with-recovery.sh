#!/usr/bin/env bash
# Migrate a single study end-to-end with auto-recovery for the
# silent-Inception partial-failure mode (PR #98 detection + runbook recovery).
#
# Usage:
#   ./scripts/batch-migrate/migrate-with-recovery.sh <study-key>
#   ./scripts/batch-migrate/migrate-with-recovery.sh <study-key> --json
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
# --json mode:
#   - All human banners go to stderr.
#   - Helpers (check-inception, recover-inception) are invoked with --json;
#     their stdout (JSON) is captured into env vars and merged into a single
#     envelope by scripts/batch-migrate/compose-envelope.js.
#   - Final stdout is one JSON object with schemaVersion: 1, outcome, and
#     exitCode fields. The bash wrapper reads envelope.exitCode and exits
#     with that value (single source of truth — R15).
#
# Exit codes (default mode):
#   0 = clean migration (with or without auto-recovery)
#   1 = recovery failed or unrecoverable orchestrator error
#   2 = check-inception inconclusive — investigate (R2; transient)
#
# Exit codes (--json mode):
#   Read directly from envelope.exitCode. Mapping:
#   0 = outcome clean / recovered / already_success
#   1 = outcome failed
#   2 = outcome inconclusive

set -uo pipefail

JSON_MODE=false
STUDY=""
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=true ;;
    --*)    echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)      if [ -z "$STUDY" ]; then STUDY="$arg"; fi ;;
  esac
done

if [ -z "$STUDY" ]; then
  if [ "$JSON_MODE" = true ]; then
    echo '{"schemaVersion":1,"ok":false,"error":{"code":"usage","message":"<study-key> is required"},"exitCode":1}'
  else
    echo "Usage: $0 <study-key> [--json]" >&2
  fi
  exit 1
fi

cd "$(dirname "$0")/../.." || exit 1  # cd to engine repo root

# In JSON mode banners go to stderr; in default mode they go to stdout.
banner() {
  if [ "$JSON_MODE" = true ]; then
    echo "$@" >&2
  else
    echo "$@"
  fi
}

banner ""
banner "================================================================"
banner "  migrate-with-recovery: $STUDY  ($(date -u +%H:%M:%S)Z)"
banner "================================================================"

# ─── Step 1: orchestrator ─────────────────────────────────────────────────
banner ""
banner "[1/3] Run orchestrator (full pipeline)"

if [ "$JSON_MODE" = true ]; then
  # Capture orchestrator stdout+stderr; keep last 20 lines as tail.
  # batch-migrate.js doesn't support --json; treat its output as opaque.
  ORCH_OUTPUT=$(node scripts/batch-migrate/batch-migrate.js --study "$STUDY" 2>&1)
  ORCH_EXIT=$?
  ORCH_TAIL=$(printf '%s' "$ORCH_OUTPUT" | tail -n 20)
else
  node scripts/batch-migrate/batch-migrate.js --study "$STUDY"
  ORCH_EXIT=$?
  ORCH_TAIL=""
fi

if [ $ORCH_EXIT -ne 0 ] && [ "$JSON_MODE" = false ]; then
  echo "Orchestrator failed with exit $ORCH_EXIT" >&2
  exit 1
fi

# ─── Step 2: check Inception Activity Log ─────────────────────────────────
banner ""
banner "[2/3] Check Activity Log for Inception status"

if [ "$JSON_MODE" = true ]; then
  CHECK_JSON=$(node scripts/batch-migrate/check-inception.js --study "$STUDY" --json 2>/dev/null)
  CHECK_EXIT=$?
else
  node scripts/batch-migrate/check-inception.js --study "$STUDY"
  CHECK_EXIT=$?
  CHECK_JSON=""
fi

# ─── Decide whether to recover ────────────────────────────────────────────
RECOVERY_JSON=""
REMIG_EXIT=""
REMIG_TAIL=""
FINAL_CHECK_JSON=""

case $CHECK_EXIT in
  0)
    banner "✓ Inception Success — no recovery needed"
    ;;
  1)
    banner "⚠ Inception Failed (Batch incomplete) — running recovery..."
    banner ""
    banner "[3/3] Recover (runbook procedure)"

    if [ "$JSON_MODE" = true ]; then
      RECOVERY_JSON=$(node scripts/batch-migrate/recover-inception.js --study "$STUDY" --json 2>/dev/null)
      REC_EXIT=$?
    else
      node scripts/batch-migrate/recover-inception.js --study "$STUDY"
      REC_EXIT=$?
    fi

    if [ $REC_EXIT -ne 0 ] && [ $REC_EXIT -ne 2 ]; then
      # exit 2 = alreadySuccess (no work needed); not a failure
      if [ "$JSON_MODE" = false ]; then
        echo "Recovery failed with exit $REC_EXIT — escalate" >&2
        exit 1
      fi
      # JSON mode: continue to compose envelope so caller sees the failure shape.
    elif [ $REC_EXIT -eq 0 ]; then
      banner ""
      banner "[3b] Re-fire Migrator on full cascade state"

      if [ "$JSON_MODE" = true ]; then
        REMIG_OUTPUT=$(node scripts/batch-migrate/batch-migrate.js --study "$STUDY" --skip-create-study --skip-inception 2>&1)
        REMIG_EXIT=$?
        REMIG_TAIL=$(printf '%s' "$REMIG_OUTPUT" | tail -n 20)
      else
        node scripts/batch-migrate/batch-migrate.js --study "$STUDY" --skip-create-study --skip-inception
        REMIG_EXIT=$?
      fi

      if [ "$REMIG_EXIT" != "0" ] && [ "$JSON_MODE" = false ]; then
        echo "Migrator re-fire failed" >&2
        exit 1
      fi

      # Post-recovery final check (JSON mode only — default mode shows pipeline output).
      if [ "$JSON_MODE" = true ]; then
        FINAL_CHECK_JSON=$(node scripts/batch-migrate/check-inception.js --study "$STUDY" --json 2>/dev/null)
      fi
    fi
    ;;
  4)
    # R2: check-inception reports transient/inconclusive (network 5xx, timeout,
    # ECONNRESET). DO NOT trigger destructive recovery. Operator should retry
    # the check after the network blip clears.
    if [ "$JSON_MODE" = false ]; then
      echo "⚠ check-inception inconclusive (transient/network) — do NOT auto-recover; retry the check" >&2
      exit 2
    fi
    # JSON mode: fall through, envelope captures CHECK_JSON state and outcome.
    ;;
  *)
    if [ "$JSON_MODE" = false ]; then
      echo "check-inception returned exit $CHECK_EXIT — investigate" >&2
      exit 1
    fi
    # JSON mode: fall through, envelope captures CHECK_JSON state.
    ;;
esac

# ─── JSON mode: compose envelope ──────────────────────────────────────────
if [ "$JSON_MODE" = true ]; then
  STUDY="$STUDY" \
  ORCH_EXIT_CODE="$ORCH_EXIT" \
  ORCH_TAIL="$ORCH_TAIL" \
  CHECK_JSON="$CHECK_JSON" \
  RECOVERY_JSON="$RECOVERY_JSON" \
  REMIG_EXIT_CODE="$REMIG_EXIT" \
  REMIG_TAIL="$REMIG_TAIL" \
  FINAL_CHECK_JSON="$FINAL_CHECK_JSON" \
  ENVELOPE_JSON=$(node scripts/batch-migrate/compose-envelope.js)
  COMPOSE_EXIT=$?

  if [ $COMPOSE_EXIT -ne 0 ]; then
    # compose-envelope.js writes its own fallback JSON on failure; forward exit.
    printf '%s\n' "$ENVELOPE_JSON"
    exit $COMPOSE_EXIT
  fi

  # Emit envelope to stdout. Read envelope.exitCode (R15 — single source of
  # truth, no parallel shell logic).
  printf '%s\n' "$ENVELOPE_JSON"
  ENVELOPE_EXIT=$(printf '%s' "$ENVELOPE_JSON" | node -e "
    const env = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    process.stdout.write(String(env.exitCode ?? 1));
  ")
  exit "$ENVELOPE_EXIT"
fi

banner ""
banner "✓ $STUDY complete  ($(date -u +%H:%M:%S)Z)"
exit 0
