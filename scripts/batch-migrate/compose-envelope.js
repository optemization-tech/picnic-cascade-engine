#!/usr/bin/env node
/**
 * Compose a single JSON envelope from the per-step JSON outputs of
 * `migrate-with-recovery.sh --json`.
 *
 * Reads from env vars (the bash wrapper exports them before invoking this
 * script — keeps argv short and avoids quoting hell):
 *
 *   STUDY              — study key (string, required)
 *   ORCH_EXIT_CODE     — exit code of initial batch-migrate.js run (number)
 *   ORCH_TAIL          — last ~20 lines of orchestrator stdout
 *   CHECK_JSON         — JSON string from check-inception.js --json (initial)
 *   RECOVERY_JSON      — JSON string from recover-inception.js --json
 *                        (empty when no recovery ran)
 *   REMIG_EXIT_CODE    — exit code of re-migrator (empty when no recovery)
 *   REMIG_TAIL         — last lines of re-migrator stdout (empty when none)
 *   FINAL_CHECK_JSON   — JSON string from check-inception.js --json
 *                        (post-recovery, empty when no recovery ran)
 *
 * Emits a single JSON object on stdout with `schemaVersion: 1` at the top.
 *
 * Exit codes:
 *   0 = envelope composed (regardless of inner outcome — outcome is in JSON)
 *   1 = composition failure (writes a fallback error envelope to stdout)
 */

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

  const recoveryPerformed = recoveryParsed.value !== null;

  // Outcome derivation.
  const orchOk = orchExitCode === 0;
  const checkSuccess = checkParsed.value?.state === 'success';
  const finalCheckSuccess = finalCheckParsed.value?.state === 'success';

  let outcome;
  if (!recoveryPerformed) {
    outcome = (orchOk && checkSuccess) ? 'clean' : 'failed';
  } else {
    const reMigOk = reMigExitCode === 0;
    outcome = (reMigOk && finalCheckSuccess) ? 'recovered' : 'failed';
  }

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
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
      error: { code: 'compose_failed', message: String(err.message || err).slice(0, 400) },
    }) + '\n');
    process.exit(1);
  }
}
