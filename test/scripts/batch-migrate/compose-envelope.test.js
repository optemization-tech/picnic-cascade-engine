/**
 * Tests for compose-envelope.js — outcome derivation, exitCode mapping,
 * conditional rules per Q5/Q10, parseErrors collection.
 */
import { describe, it, expect } from 'vitest';
import {
  composeEnvelope,
  deriveOutcome,
  exitCodeFromOutcome,
} from '../../../scripts/batch-migrate/compose-envelope.js';

const STUDY = 'ionis-hae-001';

const checkSuccess = JSON.stringify({
  schemaVersion: 1, ok: true, study: STUDY, studyName: 'Ionis HAE 001',
  inceptionStatus: 'Success', state: 'success',
});

const checkFailed = JSON.stringify({
  schemaVersion: 1, ok: true, study: STUDY, studyName: 'Ionis HAE 001',
  inceptionStatus: 'Failed', state: 'failed',
});

const checkInProgress = JSON.stringify({
  schemaVersion: 1, ok: true, study: STUDY, studyName: 'Ionis HAE 001',
  inceptionStatus: 'In Progress', state: 'in_progress',
});

const checkNoEntry = JSON.stringify({
  schemaVersion: 1, ok: true, study: STUDY, state: 'no_entry',
});

const checkInconclusive = JSON.stringify({
  schemaVersion: 1, ok: false, study: STUDY, state: 'inconclusive',
  error: { code: 'transient', message: 'network timeout' },
});

const recoveryAlreadySuccess = JSON.stringify({
  schemaVersion: 1, ok: true, study: STUDY, alreadySuccess: true, state: 'already_success',
});

const recoverySuccess = JSON.stringify({
  schemaVersion: 1, ok: true, study: STUDY,
  stages: [{ name: 'deletion', status: 'ok' }, { name: 'clearAudit', status: 'ok' }, { name: 'reInception', status: 'ok' }],
  ready: 'Migrator can be re-fired with --skip-create-study --skip-inception',
});

const recoveryFailed = JSON.stringify({
  schemaVersion: 1, ok: false, study: STUDY,
  error: { code: 'inception_not_success', message: '...' },
  stages: [{ name: 'deletion', status: 'ok' }, { name: 'clearAudit', status: 'ok' }, { name: 'reInception', status: 'failed' }],
});

// ──────────────────────────────────────────────────────────────────────────
// deriveOutcome — pure function tests
// ──────────────────────────────────────────────────────────────────────────
describe('deriveOutcome', () => {
  it('returns clean when orchestrator OK and check is success (no recovery)', () => {
    const outcome = deriveOutcome({
      orchExitCode: 0,
      check: { state: 'success' },
      recovery: null,
      finalCheck: null,
      recoveryPerformed: false,
    });
    expect(outcome).toBe('clean');
  });

  it('returns failed when orchestrator failed even if check is success (orch dominates per Q5)', () => {
    const outcome = deriveOutcome({
      orchExitCode: 1,
      check: { state: 'success' },
      recovery: null,
      finalCheck: null,
      recoveryPerformed: false,
    });
    expect(outcome).toBe('failed');
  });

  it('returns inconclusive when orch OK and check is in_progress (Q5 conditional)', () => {
    const outcome = deriveOutcome({
      orchExitCode: 0,
      check: { state: 'in_progress' },
      recovery: null,
      finalCheck: null,
      recoveryPerformed: false,
    });
    expect(outcome).toBe('inconclusive');
  });

  it('returns failed when orch failed AND check is in_progress (Q5 conditional)', () => {
    const outcome = deriveOutcome({
      orchExitCode: 1,
      check: { state: 'in_progress' },
      recovery: null,
      finalCheck: null,
      recoveryPerformed: false,
    });
    expect(outcome).toBe('failed');
  });

  it('returns inconclusive for unknown / cancelled states when orch OK', () => {
    expect(deriveOutcome({
      orchExitCode: 0, check: { state: 'unknown' }, recovery: null, finalCheck: null, recoveryPerformed: false,
    })).toBe('inconclusive');
    expect(deriveOutcome({
      orchExitCode: 0, check: { state: 'cancelled' }, recovery: null, finalCheck: null, recoveryPerformed: false,
    })).toBe('inconclusive');
  });

  it('returns failed when state is no_entry / no_exported_row / no_production_study', () => {
    expect(deriveOutcome({
      orchExitCode: 0, check: { state: 'no_entry' }, recovery: null, finalCheck: null, recoveryPerformed: false,
    })).toBe('failed');
    expect(deriveOutcome({
      orchExitCode: 0, check: { state: 'no_exported_row' }, recovery: null, finalCheck: null, recoveryPerformed: false,
    })).toBe('failed');
    expect(deriveOutcome({
      orchExitCode: 0, check: { state: 'no_production_study' }, recovery: null, finalCheck: null, recoveryPerformed: false,
    })).toBe('failed');
  });

  it('returns inconclusive when check.state is inconclusive (transient from U4)', () => {
    expect(deriveOutcome({
      orchExitCode: 0, check: { state: 'inconclusive' }, recovery: null, finalCheck: null, recoveryPerformed: false,
    })).toBe('inconclusive');
  });

  it('returns already_success when recovery alreadySuccess and orch OK (Q10)', () => {
    const outcome = deriveOutcome({
      orchExitCode: 0,
      check: { state: 'failed' }, // check said Failed → recovery checked
      recovery: { alreadySuccess: true },
      finalCheck: null,
      recoveryPerformed: false,
    });
    expect(outcome).toBe('already_success');
  });

  it('returns failed when recovery alreadySuccess BUT orch failed (Q10 — orch dominates)', () => {
    const outcome = deriveOutcome({
      orchExitCode: 1,
      check: { state: 'failed' },
      recovery: { alreadySuccess: true },
      finalCheck: null,
      recoveryPerformed: false,
    });
    expect(outcome).toBe('failed');
  });

  it('returns recovered when recovery ran and final check is success', () => {
    const outcome = deriveOutcome({
      orchExitCode: 0,
      check: { state: 'failed' },
      recovery: { ok: true, stages: [{ name: 'deletion', status: 'ok' }] },
      finalCheck: { state: 'success' },
      recoveryPerformed: true,
    });
    expect(outcome).toBe('recovered');
  });

  it('returns failed when recovery ran but final check still failed', () => {
    const outcome = deriveOutcome({
      orchExitCode: 0,
      check: { state: 'failed' },
      recovery: { ok: true, stages: [{ name: 'deletion', status: 'ok' }] },
      finalCheck: { state: 'failed' },
      recoveryPerformed: true,
    });
    expect(outcome).toBe('failed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// exitCodeFromOutcome
// ──────────────────────────────────────────────────────────────────────────
describe('exitCodeFromOutcome', () => {
  it('maps clean / recovered / already_success → 0', () => {
    expect(exitCodeFromOutcome('clean')).toBe(0);
    expect(exitCodeFromOutcome('recovered')).toBe(0);
    expect(exitCodeFromOutcome('already_success')).toBe(0);
  });

  it('maps inconclusive → 2', () => {
    expect(exitCodeFromOutcome('inconclusive')).toBe(2);
  });

  it('maps failed → 1', () => {
    expect(exitCodeFromOutcome('failed')).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// composeEnvelope — full integration
// ──────────────────────────────────────────────────────────────────────────
describe('composeEnvelope', () => {
  it('emits schemaVersion: 1 + exitCode at top level', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: 'OK',
      checkJson: checkSuccess,
    });
    expect(env.schemaVersion).toBe(1);
    expect(env.exitCode).toBeDefined();
  });

  it('marks outcome=clean + exitCode=0 + ok=true on happy path', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: 'orchestrator clean',
      checkJson: checkSuccess,
      recoveryJson: '',
    });
    expect(env.outcome).toBe('clean');
    expect(env.exitCode).toBe(0);
    expect(env.ok).toBe(true);
    expect(env.recoveryPerformed).toBe(false);
    expect(env.recovery).toBeNull();
    expect(env.reMigrator).toBeNull();
  });

  it('marks outcome=recovered + exitCode=0 when recovery ran and final check is success', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkFailed,
      recoveryJson: recoverySuccess,
      reMigExitCode: 0,
      reMigTail: '',
      finalCheckJson: checkSuccess,
    });
    expect(env.outcome).toBe('recovered');
    expect(env.exitCode).toBe(0);
    expect(env.recoveryPerformed).toBe(true);
    expect(env.finalCheck).not.toBeNull();
  });

  it('marks outcome=already_success + exitCode=0 when recovery alreadySuccess and orch OK', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkFailed,
      recoveryJson: recoveryAlreadySuccess,
    });
    expect(env.outcome).toBe('already_success');
    expect(env.exitCode).toBe(0);
    // recoveryPerformed is FALSE for alreadySuccess (R12 semantics — recovery
    // checked but didn't run)
    expect(env.recoveryPerformed).toBe(false);
  });

  it('marks outcome=failed + exitCode=1 when alreadySuccess but orch failed (Q10)', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 1,
      orchTail: 'orchestrator failed',
      checkJson: checkFailed,
      recoveryJson: recoveryAlreadySuccess,
    });
    expect(env.outcome).toBe('failed');
    expect(env.exitCode).toBe(1);
    expect(env.ok).toBe(false);
  });

  it('marks outcome=inconclusive + exitCode=2 when check returned inconclusive', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkInconclusive,
    });
    expect(env.outcome).toBe('inconclusive');
    expect(env.exitCode).toBe(2);
  });

  it('marks outcome=inconclusive when in_progress and orch OK (Q5)', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkInProgress,
    });
    expect(env.outcome).toBe('inconclusive');
    expect(env.exitCode).toBe(2);
  });

  it('marks outcome=failed when in_progress AND orch failed (Q5 conditional)', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 1,
      orchTail: '...',
      checkJson: checkInProgress,
    });
    expect(env.outcome).toBe('failed');
    expect(env.exitCode).toBe(1);
  });

  it('marks outcome=failed when no_entry and no recovery', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkNoEntry,
    });
    expect(env.outcome).toBe('failed');
    expect(env.exitCode).toBe(1);
  });

  it('captures parseErrors when an inner JSON snippet is malformed', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: '{not json',
    });
    expect(env.parseErrors).toBeDefined();
    expect(env.parseErrors.find((e) => e.field === 'check')).toBeDefined();
    expect(env.check).toBeNull();
  });

  it('omits parseErrors when all snippets parse cleanly', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkSuccess,
    });
    expect(env.parseErrors).toBeUndefined();
  });

  it('passes orchestrator exitCode and stdoutTail through to envelope', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 1,
      orchTail: 'last 20 lines of orchestrator output',
      checkJson: checkFailed,
    });
    expect(env.orchestrator.exitCode).toBe(1);
    expect(env.orchestrator.stdoutTail).toBe('last 20 lines of orchestrator output');
  });

  it('handles empty recoveryJson as recoveryPerformed=false', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      checkJson: checkSuccess,
      recoveryJson: '',
    });
    expect(env.recoveryPerformed).toBe(false);
    expect(env.reMigrator).toBeNull();
    expect(env.finalCheck).toBeNull();
  });

  it('marks outcome=failed + exitCode=1 when recovery ran but failed', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkFailed,
      recoveryJson: recoveryFailed,
      reMigExitCode: null,
      reMigTail: '',
      finalCheckJson: '',
    });
    expect(env.outcome).toBe('failed');
    expect(env.exitCode).toBe(1);
    expect(env.recoveryPerformed).toBe(true);
  });
});
