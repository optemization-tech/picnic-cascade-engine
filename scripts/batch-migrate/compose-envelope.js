#!/usr/bin/env node
//
// compose-envelope.js — merges per-step JSON outputs from
// migrate-with-recovery.sh's sub-invocations into a single envelope.
//
// ─── schemaVersion bump policy ─────────────────────────────────────────
//   Additive changes (new fields, new error codes, new outcome values,
//     new state tokens): no bump.
//   Field rename or removal, or change to existing field semantics:
//     bump (1 → 2).
//   Future versions MAY include `compatibleWith: ['1']` for back-compat
//     reading.
// ──────────────────────────────────────────────────────────────────────
//
// Invoked by the wrapper bash script in --json mode. Reads piece-vars
// from process.env to keep argv short and avoid quoting hell.
//
// Env vars (all optional unless noted):
//   STUDY              — study key (string)
//   ORCH_EXIT_CODE     — exit code of initial batch-migrate.js run
//   ORCH_TAIL          — last ~20 lines of orchestrator stdout+stderr
//   CHECK_JSON         — JSON string from check-inception.js --json (initial)
//   RECOVERY_JSON      — JSON string from recover-inception.js --json
//                        (empty when no recovery ran)
//   REMIG_EXIT_CODE    — exit code of re-migrator (empty when no recovery)
//   REMIG_TAIL         — last lines of re-migrator stdout (empty when none)
//   FINAL_CHECK_JSON   — JSON string from check-inception.js --json
//                        (post-recovery, empty when no recovery ran)
//
// Emits a single JSON envelope on stdout with `schemaVersion: 1`.
//
// ─── Outcome derivation rules (R5, R12, R18) ───────────────────────────
//
// The composer reads the inner check's `state` field plus the orchestrator
// exit code to derive the wrapper-level `outcome`:
//
//   check.state                       outcome (per orch_exit)
//   ─────────────────                 ───────────────────────
//   success                           clean
//   failed (and recovery ran)         recovered (if final clean) | failed
//   failed (no recovery)              failed
//   no_entry                          failed
//   no_exported_row                   failed
//   no_production_study               failed
//   in_progress / unknown / cancelled failed (if orch_exit ≠ 0) | inconclusive
//   inconclusive (transient from U4)  inconclusive
//   recovery.alreadySuccess: true     already_success (orch clean) | failed (orch failed)
//
// Q5 / Q10: orchestrator failure dominates over in-flight or alreadySuccess
// signals from the inner helpers. compose-envelope reads ORCH_EXIT_CODE and
// applies the conditional rule.
//
// ─── exitCode derivation (R15 / R1) ────────────────────────────────────
//
//   outcome              exitCode
//   ─────────────        ────────
//   clean                  0
//   recovered              0
//   already_success        0
//   inconclusive           2
//   failed                 1
//
// The bash wrapper reads envelope.exitCode and exits with that value
// (single source of truth). No parallel exit-code derivation in shell.
//
// Exit codes (this script):
//   0 = envelope composed (regardless of inner outcome — outcome is in JSON)
//   1 = composition failure (writes a fallback error envelope to stdout)

const SCHEMA_VERSION = 1;

function safeParse(s) {
  if (!s || s.trim() === '') return { value: null, error: null };
  try {
    return { value: JSON.parse(s), error: null };
  } catch (err) {
    return { value: null, error: String(err.message || err).slice(0, 200) };
  }
}

function parseExitCode(s) {
  if (s === undefined || s === null || s === '') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function isInflightState(state) {
  return state === 'in_progress' || state === 'unknown' || state === 'cancelled';
}

function isFailedState(state) {
  return state === 'failed'
    || state === 'no_entry'
    || state === 'no_exported_row'
    || state === 'no_production_study';
}

/**
 * Derive the wrapper-level `outcome` from the composed pieces.
 *
 * Rules implement R5, R12, R18 (conditional on orch_exit).
 */
export function deriveOutcome({ orchExitCode, check, recovery, finalCheck, recoveryPerformed }) {
  const orchOk = orchExitCode === 0;

  // alreadySuccess path — recovery checked but didn't run because the prior
  // Inception was already Success. Q10: if orchestrator failed, outcome is
  // failed (orch dominates).
  if (recovery?.alreadySuccess === true) {
    return orchOk ? 'already_success' : 'failed';
  }

  if (recoveryPerformed) {
    // Recovery ran. Outcome depends on whether the post-recovery state is clean.
    // If we have a finalCheck, prefer that. Otherwise fall back to recovery's
    // own ok signal.
    if (finalCheck?.state === 'success') return 'recovered';
    if (recovery?.ok === true && !finalCheck) return 'recovered';
    return 'failed';
  }

  // No recovery ran. Outcome derived from check + orch.
  const state = check?.state;
  if (state === 'success' && orchOk) return 'clean';
  if (state === 'success' && !orchOk) return 'failed'; // orch dominates
  if (state === 'inconclusive') return 'inconclusive';
  if (isInflightState(state)) {
    return orchOk ? 'inconclusive' : 'failed'; // Q5 conditional
  }
  if (isFailedState(state)) return 'failed';

  // Defensive fallback — unknown/missing state.
  return orchOk ? 'failed' : 'failed';
}

/**
 * Map outcome → exit code (R15).
 */
export function exitCodeFromOutcome(outcome) {
  if (outcome === 'clean' || outcome === 'recovered' || outcome === 'already_success') return 0;
  if (outcome === 'inconclusive') return 2;
  return 1;
}

export function composeEnvelope(input) {
  const {
    study,
    orchExitCode,
    orchTail,
    checkJson,
    recoveryJson,
    reMigExitCode,
    reMigTail,
    finalCheckJson,
  } = input;

  const parseErrors = [];
  const checkParsed = safeParse(checkJson);
  if (checkParsed.error) parseErrors.push({ field: 'check', message: checkParsed.error });
  const recoveryParsed = safeParse(recoveryJson);
  if (recoveryParsed.error) parseErrors.push({ field: 'recovery', message: recoveryParsed.error });
  const finalCheckParsed = safeParse(finalCheckJson);
  if (finalCheckParsed.error) parseErrors.push({ field: 'finalCheck', message: finalCheckParsed.error });

  // recoveryPerformed semantics (R12): true if recovery ran AND wasn't an
  // alreadySuccess early-exit. The alreadySuccess case is "recovery was
  // checked but no work was done."
  const recoveryRan = recoveryParsed.value !== null;
  const recoveryWasAlreadySuccess = recoveryParsed.value?.alreadySuccess === true;
  const recoveryPerformed = recoveryRan && !recoveryWasAlreadySuccess;

  const outcome = deriveOutcome({
    orchExitCode,
    check: checkParsed.value,
    recovery: recoveryParsed.value,
    finalCheck: finalCheckParsed.value,
    recoveryPerformed,
  });
  const exitCode = exitCodeFromOutcome(outcome);

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    ok: outcome !== 'failed',
    study: study || null,
    orchestrator: {
      exitCode: orchExitCode,
      stdoutTail: orchTail || '',
    },
    check: checkParsed.value,
    recoveryPerformed,
    recovery: recoveryParsed.value,
    reMigrator: recoveryPerformed
      ? { exitCode: reMigExitCode, stdoutTail: reMigTail || '' }
      : null,
    finalCheck: recoveryPerformed ? finalCheckParsed.value : null,
    outcome,
    exitCode,
  };

  if (parseErrors.length > 0) {
    envelope.parseErrors = parseErrors;
  }

  return envelope;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const envelope = composeEnvelope({
      study: process.env.STUDY,
      orchExitCode: parseExitCode(process.env.ORCH_EXIT_CODE),
      orchTail: process.env.ORCH_TAIL,
      checkJson: process.env.CHECK_JSON,
      recoveryJson: process.env.RECOVERY_JSON,
      reMigExitCode: parseExitCode(process.env.REMIG_EXIT_CODE),
      reMigTail: process.env.REMIG_TAIL,
      finalCheckJson: process.env.FINAL_CHECK_JSON,
    });
    process.stdout.write(JSON.stringify(envelope) + '\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      error: { code: 'compose_failed', message: String(err?.message || err).slice(0, 400) },
      exitCode: 1,
    }) + '\n');
    process.exit(1);
  }
}
