import { describe, it, expect } from 'vitest';
import { composeEnvelope } from '../../../scripts/batch-migrate/compose-envelope.js';

const STUDY = 'ionis-hae-001';

const checkSuccessJson = JSON.stringify({
  schemaVersion: 1,
  study: STUDY,
  studyName: 'Ionis HAE 001',
  inceptionStatus: 'Success',
  state: 'success',
});

const checkFailedJson = JSON.stringify({
  schemaVersion: 1,
  study: STUDY,
  studyName: 'Ionis HAE 001',
  inceptionStatus: 'Failed',
  state: 'failed',
});

const recoverySuccessJson = JSON.stringify({
  schemaVersion: 1,
  study: STUDY,
  stages: [
    { name: 'deletion', status: 'ok' },
    { name: 'clearAudit', status: 'ok' },
    { name: 'reInception', status: 'ok' },
  ],
  ready: 'Migrator can be re-fired with --skip-create-study --skip-inception',
});

describe('composeEnvelope', () => {
  it('emits schemaVersion: 1 at the top', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: 'OK',
      checkJson: checkSuccessJson,
    });
    expect(env.schemaVersion).toBe(1);
  });

  it('marks outcome=clean when orchestrator OK and check is success and no recovery ran', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: 'orchestrator clean',
      checkJson: checkSuccessJson,
      recoveryJson: '',
      reMigExitCode: null,
      reMigTail: '',
      finalCheckJson: '',
    });
    expect(env.outcome).toBe('clean');
    expect(env.recoveryPerformed).toBe(false);
    expect(env.recovery).toBeNull();
    expect(env.finalCheck).toBeNull();
    expect(env.reMigrator).toBeNull();
    expect(env.check.state).toBe('success');
  });

  it('marks outcome=recovered when recovery ran and final check is success', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkFailedJson,
      recoveryJson: recoverySuccessJson,
      reMigExitCode: 0,
      reMigTail: 're-migrator clean',
      finalCheckJson: checkSuccessJson,
    });
    expect(env.outcome).toBe('recovered');
    expect(env.recoveryPerformed).toBe(true);
    expect(env.recovery.stages).toHaveLength(3);
    expect(env.finalCheck.state).toBe('success');
    expect(env.reMigrator.exitCode).toBe(0);
  });

  it('marks outcome=failed when recovery ran but final check still failed', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkFailedJson,
      recoveryJson: recoverySuccessJson,
      reMigExitCode: 0,
      reMigTail: '',
      finalCheckJson: checkFailedJson,
    });
    expect(env.outcome).toBe('failed');
    expect(env.recoveryPerformed).toBe(true);
  });

  it('marks outcome=failed when no recovery ran but check did not show success', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: checkFailedJson,
      recoveryJson: '',
    });
    expect(env.outcome).toBe('failed');
    expect(env.recoveryPerformed).toBe(false);
  });

  it('captures parseErrors when an inner JSON snippet is malformed', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      orchTail: '...',
      checkJson: '{not json',
      recoveryJson: '',
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
      checkJson: checkSuccessJson,
    });
    expect(env.parseErrors).toBeUndefined();
  });

  it('passes orchestrator exitCode and stdoutTail through to envelope', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 1,
      orchTail: 'last 20 lines of orchestrator output',
      checkJson: checkFailedJson,
    });
    expect(env.orchestrator.exitCode).toBe(1);
    expect(env.orchestrator.stdoutTail).toBe('last 20 lines of orchestrator output');
  });

  it('handles empty recoveryJson as recoveryPerformed=false', () => {
    const env = composeEnvelope({
      study: STUDY,
      orchExitCode: 0,
      checkJson: checkSuccessJson,
      recoveryJson: '',
    });
    expect(env.recoveryPerformed).toBe(false);
    expect(env.reMigrator).toBeNull();
    expect(env.finalCheck).toBeNull();
  });
});
