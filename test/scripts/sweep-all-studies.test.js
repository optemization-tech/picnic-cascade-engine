import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  confirmArchive,
  pickCanonical,
  classifyPage,
  computeFlags,
} = await import('../../scripts/sweep-all-studies.js');

// Helper — build a minimal Notion-shaped page object for pickCanonical tests.
function makePage({ id, createdTime, parent = false, blockedBy = false, blocking = false }) {
  const relation = (populated) => (populated ? [{ id: 'related-x' }] : []);
  return {
    id,
    created_time: createdTime,
    properties: {
      'Parent Task': { relation: relation(parent) },
      'Blocked by': { relation: relation(blockedBy) },
      'Blocking': { relation: relation(blocking) },
    },
  };
}

describe('sweep-all-studies: confirmArchive gate', () => {
  let logFn;
  let errorFn;

  beforeEach(() => {
    logFn = vi.fn();
    errorFn = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-TTY without --yes: aborts with clear error', async () => {
    const result = await confirmArchive({
      totalCandidates: 5,
      studiesWithDuplicates: 2,
      isTty: false,
      yesFlag: false,
      logFn,
      errorFn,
    });
    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('non_tty_missing_yes');
    expect(errorFn).toHaveBeenCalledWith(expect.stringContaining('--archive requires --yes'));
  });

  it('non-TTY with --yes: proceeds and logs approval', async () => {
    const result = await confirmArchive({
      totalCandidates: 5,
      studiesWithDuplicates: 2,
      isTty: false,
      yesFlag: true,
      logFn,
      errorFn,
    });
    expect(result.proceed).toBe(true);
    expect(result.reason).toBe('non_tty_yes_flag');
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('approval granted'));
    expect(errorFn).not.toHaveBeenCalled();
  });

  it('TTY: prompt returns "y" → proceed', async () => {
    const promptFn = vi.fn().mockResolvedValue(true);
    const result = await confirmArchive({
      totalCandidates: 3,
      studiesWithDuplicates: 1,
      isTty: true,
      yesFlag: false,
      promptFn,
      logFn,
      errorFn,
    });
    expect(result.proceed).toBe(true);
    expect(result.reason).toBe('tty_approved');
    expect(promptFn).toHaveBeenCalledWith(expect.stringContaining('[y/N]'));
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('operator approved'));
  });

  it('TTY: prompt returns "n" → abort without archive', async () => {
    const promptFn = vi.fn().mockResolvedValue(false);
    const result = await confirmArchive({
      totalCandidates: 3,
      studiesWithDuplicates: 1,
      isTty: true,
      yesFlag: false,
      promptFn,
      logFn,
      errorFn,
    });
    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('tty_declined');
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('operator declined'));
  });
});

describe('sweep-all-studies: pickCanonical tri-state keep-rule', () => {
  it('classifyPage: Parent Task relation → wired', () => {
    expect(classifyPage(makePage({ id: 'a', createdTime: '2026-01-01T00:00:00Z', parent: true }))).toBe('wired');
  });

  it('classifyPage: Blocked by relation → wired', () => {
    expect(classifyPage(makePage({ id: 'a', createdTime: '2026-01-01T00:00:00Z', blockedBy: true }))).toBe('wired');
  });

  it('classifyPage: Blocking relation → wired', () => {
    expect(classifyPage(makePage({ id: 'a', createdTime: '2026-01-01T00:00:00Z', blocking: true }))).toBe('wired');
  });

  it('classifyPage: no relations → unwired', () => {
    expect(classifyPage(makePage({ id: 'a', createdTime: '2026-01-01T00:00:00Z' }))).toBe('unwired');
  });

  it('mixed (wired + unwired): keeps wired, archives unwired, state=mixed', () => {
    const wiredPage = makePage({ id: 'wired-1', createdTime: '2026-02-01T00:00:00Z', parent: true });
    const unwiredPage1 = makePage({ id: 'unwired-1', createdTime: '2026-01-01T00:00:00Z' });
    const unwiredPage2 = makePage({ id: 'unwired-2', createdTime: '2026-01-15T00:00:00Z' });
    const result = pickCanonical([wiredPage, unwiredPage1, unwiredPage2]);
    expect(result.canonical.id).toBe('wired-1');
    expect(result.groupState).toBe('mixed');
    expect(result.duplicates.map((p) => p.id).sort()).toEqual(['unwired-1', 'unwired-2']);
    expect(result.tieWarnings.size).toBe(0);
  });

  it('mixed with multiple wired: keeps earliest wired, archives all unwired', () => {
    const wiredNewer = makePage({ id: 'wired-new', createdTime: '2026-02-01T00:00:00Z', parent: true });
    const wiredOlder = makePage({ id: 'wired-old', createdTime: '2026-01-01T00:00:00Z', blockedBy: true });
    const unwired = makePage({ id: 'unwired-1', createdTime: '2025-12-01T00:00:00Z' });
    const result = pickCanonical([wiredNewer, wiredOlder, unwired]);
    expect(result.canonical.id).toBe('wired-old'); // earliest wired wins
    expect(result.groupState).toBe('mixed');
    // Both wired-new and unwired-1 are archived.
    expect(result.duplicates.map((p) => p.id).sort()).toEqual(['unwired-1', 'wired-new']);
  });

  it('all-wired: earliest created_time wins, state=all-wired', () => {
    const a = makePage({ id: 'a', createdTime: '2026-03-01T00:00:00Z', parent: true });
    const b = makePage({ id: 'b', createdTime: '2026-02-01T00:00:00Z', blocking: true });
    const c = makePage({ id: 'c', createdTime: '2026-02-15T00:00:00Z', parent: true });
    const result = pickCanonical([a, b, c]);
    expect(result.canonical.id).toBe('b');
    expect(result.groupState).toBe('all-wired');
    expect(result.tieWarnings.size).toBe(0);
  });

  it('all-wired with tie (<100ms apart): emits tie warning', () => {
    const a = makePage({ id: 'a', createdTime: '2026-02-01T00:00:00.000Z', parent: true });
    const b = makePage({ id: 'b', createdTime: '2026-02-01T00:00:00.050Z', parent: true }); // 50ms later
    const c = makePage({ id: 'c', createdTime: '2026-03-01T00:00:00.000Z', parent: true });
    const result = pickCanonical([a, b, c]);
    expect(result.canonical.id).toBe('a'); // earliest
    expect(result.groupState).toBe('all-wired');
    expect(result.tieWarnings.has('b')).toBe(true); // within 100ms → tie
    expect(result.tieWarnings.has('c')).toBe(false); // 1 month apart → no tie
  });

  it('all-unwired: earliest created_time wins, state=root-unwired', () => {
    const a = makePage({ id: 'a', createdTime: '2026-02-01T00:00:00Z' });
    const b = makePage({ id: 'b', createdTime: '2026-01-01T00:00:00Z' });
    const c = makePage({ id: 'c', createdTime: '2026-03-01T00:00:00Z' });
    const result = pickCanonical([a, b, c]);
    expect(result.canonical.id).toBe('b');
    expect(result.groupState).toBe('root-unwired');
    expect(result.tieWarnings.size).toBe(0);
  });

  it('all-unwired with tie (<100ms apart): emits tie warning', () => {
    const a = makePage({ id: 'a', createdTime: '2026-02-01T00:00:00.000Z' });
    const b = makePage({ id: 'b', createdTime: '2026-02-01T00:00:00.080Z' }); // 80ms later
    const result = pickCanonical([a, b]);
    expect(result.canonical.id).toBe('a');
    expect(result.groupState).toBe('root-unwired');
    expect(result.tieWarnings.has('b')).toBe(true);
  });

  it('empty input returns canonical=null', () => {
    const result = pickCanonical([]);
    expect(result.canonical).toBeNull();
    expect(result.groupState).toBe('empty');
  });
});

describe('sweep-all-studies: computeFlags (engine-bot protection)', () => {
  // Helper — build a minimal page shape with a last_edited_by metadata block.
  function makePageWithEditor({ type, id, status = 'Backlog' }) {
    return {
      id: 'page-x',
      last_edited_by: { type, id },
      properties: {
        Status: { status: { name: status } },
      },
    };
  }

  it('ENGINE_BOT_USER_ID set + bot edit matches → no flag', () => {
    const page = makePageWithEditor({ type: 'bot', id: 'engine-bot-id' });
    const flags = computeFlags(page, false, { engineBotUserId: 'engine-bot-id' });
    expect(flags).toEqual([]);
  });

  it('ENGINE_BOT_USER_ID set + bot edit from different bot → not-engine-bot flag', () => {
    const page = makePageWithEditor({ type: 'bot', id: 'other-bot-id' });
    const flags = computeFlags(page, false, { engineBotUserId: 'engine-bot-id' });
    expect(flags).toContain('not-engine-bot');
  });

  it('ENGINE_BOT_USER_ID unset + bot edit → flagged conservatively as not-engine-bot', () => {
    const page = makePageWithEditor({ type: 'bot', id: 'some-bot-id' });
    const flags = computeFlags(page, false, { engineBotUserId: null });
    expect(flags).toContain('not-engine-bot');
  });

  it('ENGINE_BOT_USER_ID unset + human edit → flagged as human (always)', () => {
    const page = makePageWithEditor({ type: 'person', id: 'user-id' });
    const flags = computeFlags(page, false, { engineBotUserId: null });
    expect(flags).toContain('last_edited_by_human');
    expect(flags).not.toContain('not-engine-bot'); // bot-specific flag doesn't apply to humans
  });

  it('ENGINE_BOT_USER_ID set + human edit → flagged as human', () => {
    const page = makePageWithEditor({ type: 'person', id: 'user-id' });
    const flags = computeFlags(page, false, { engineBotUserId: 'engine-bot-id' });
    expect(flags).toContain('last_edited_by_human');
  });

  it('hasComments flag propagates', () => {
    const page = makePageWithEditor({ type: 'bot', id: 'engine-bot-id' });
    const flags = computeFlags(page, true, { engineBotUserId: 'engine-bot-id' });
    expect(flags).toContain('has_comments');
  });

  it('non-default status flagged', () => {
    const page = makePageWithEditor({ type: 'bot', id: 'engine-bot-id', status: 'In Progress' });
    const flags = computeFlags(page, false, { engineBotUserId: 'engine-bot-id' });
    expect(flags).toContain('status:In Progress');
  });
});
