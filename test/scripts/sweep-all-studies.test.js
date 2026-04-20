import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  confirmArchive,
} = await import('../../scripts/sweep-all-studies.js');

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
