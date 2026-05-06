import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the production WEBHOOK_SECRET startup assertion in src/config.js.
//
// The assertion runs at module-import time, so each test re-imports config.js
// after stubbing the relevant env vars. We also stub the other required env
// vars (NOTION_TOKEN_1, STUDY_TASKS_DB_ID, STUDIES_DB_ID) so the positive
// cases reach the WEBHOOK_SECRET check rather than failing earlier on those.
//
// Plan: docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md (U1 step 6).

describe('config — production WEBHOOK_SECRET assertion', () => {
  beforeEach(() => {
    vi.resetModules();
    // Provide the other required env vars so the assertion is the only thing
    // gating module load. Without these, collectTokensRequired/required()
    // would throw on a different missing var and we wouldn't be testing the
    // WEBHOOK_SECRET branch.
    vi.stubEnv('NOTION_TOKEN_1', 'tok-1');
    vi.stubEnv('STUDY_TASKS_DB_ID', 'study-tasks-db');
    vi.stubEnv('STUDIES_DB_ID', 'studies-db');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws when NODE_ENV=production and WEBHOOK_SECRET is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEBHOOK_SECRET', '');

    await expect(import('../src/config.js')).rejects.toThrow(/WEBHOOK_SECRET/);
  });

  it('throws when WEBHOOK_SECRET is whitespace-only', async () => {
    // Reviewers flagged that `!process.env.WEBHOOK_SECRET` accepts `' '`.
    // Strength check must reject after trim.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEBHOOK_SECRET', '   ');

    await expect(import('../src/config.js')).rejects.toThrow(/WEBHOOK_SECRET/);
  });

  it('throws when WEBHOOK_SECRET is shorter than the minimum', async () => {
    // 'short' is below the 16-char minimum.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEBHOOK_SECRET', 'short');

    await expect(import('../src/config.js')).rejects.toThrow(/at least 16/);
  });

  it('does not throw when NODE_ENV=production and WEBHOOK_SECRET meets the minimum', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEBHOOK_SECRET', 'abcdefghijklmnop'); // 16 chars exactly

    await expect(import('../src/config.js')).resolves.toBeDefined();
  });

  it('does not throw when NODE_ENV=development and WEBHOOK_SECRET is unset', async () => {
    // Local dev / test ergonomics: keep the middleware's permissive behavior
    // when not in production. Without this, every contributor would need to
    // set WEBHOOK_SECRET locally just to import config.js or run tests.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WEBHOOK_SECRET', '');

    await expect(import('../src/config.js')).resolves.toBeDefined();
  });

  it('does not throw when NODE_ENV is unset and WEBHOOK_SECRET is unset', async () => {
    // NODE_ENV defaults to 'development' inside config.js when unset.
    vi.stubEnv('NODE_ENV', '');
    vi.stubEnv('WEBHOOK_SECRET', '');

    await expect(import('../src/config.js')).resolves.toBeDefined();
  });
});
