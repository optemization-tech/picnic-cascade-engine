import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepStuckImportMode } from '../../src/startup/import-mode-sweep.js';

describe('sweepStuckImportMode', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      queryDatabase: vi.fn(),
      patchPage: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes with no resets when no studies have Import Mode stuck ON', async () => {
    mockClient.queryDatabase.mockResolvedValue([]);

    const result = await sweepStuckImportMode(mockClient, 'db-studies');

    expect(result).toEqual({ studiesFound: 0, studiesReset: 0 });
    expect(mockClient.queryDatabase).toHaveBeenCalledWith(
      'db-studies',
      { property: 'Import Mode', checkbox: { equals: true } },
    );
    expect(mockClient.patchPage).not.toHaveBeenCalled();

    // Verify structured JSON log
    const logCall = console.log.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('import_mode_sweep'),
    );
    expect(logCall).toBeTruthy();
    const logged = JSON.parse(logCall[0]);
    expect(logged).toEqual({ event: 'import_mode_sweep', studiesFound: 0, studiesReset: 0 });
  });

  it('resets both studies when 2 have Import Mode stuck ON', async () => {
    const stuckStudies = [
      { id: 'study-aaa' },
      { id: 'study-bbb' },
    ];
    mockClient.queryDatabase.mockResolvedValue(stuckStudies);
    mockClient.patchPage.mockResolvedValue({});

    const result = await sweepStuckImportMode(mockClient, 'db-studies');

    expect(result).toEqual({ studiesFound: 2, studiesReset: 2 });
    expect(mockClient.patchPage).toHaveBeenCalledTimes(2);
    expect(mockClient.patchPage).toHaveBeenCalledWith('study-aaa', {
      'Import Mode': { checkbox: false },
    });
    expect(mockClient.patchPage).toHaveBeenCalledWith('study-bbb', {
      'Import Mode': { checkbox: false },
    });

    // Verify structured JSON log
    const logCall = console.log.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('import_mode_sweep'),
    );
    const logged = JSON.parse(logCall[0]);
    expect(logged).toEqual({ event: 'import_mode_sweep', studiesFound: 2, studiesReset: 2 });
  });

  it('logs error and does not throw when Notion query fails', async () => {
    mockClient.queryDatabase.mockRejectedValue(new Error('Notion API 500'));

    const result = await sweepStuckImportMode(mockClient, 'db-studies');

    // Should return zeros — not throw
    expect(result).toEqual({ studiesFound: 0, studiesReset: 0 });
    expect(mockClient.patchPage).not.toHaveBeenCalled();

    // Verify structured JSON error log
    const errorCall = console.error.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('import_mode_sweep_error'),
    );
    expect(errorCall).toBeTruthy();
    const logged = JSON.parse(errorCall[0]);
    expect(logged).toEqual({ event: 'import_mode_sweep_error', error: 'Notion API 500' });
  });

  it('continues patching remaining studies when one PATCH fails', async () => {
    const stuckStudies = [
      { id: 'study-fail' },
      { id: 'study-ok' },
    ];
    mockClient.queryDatabase.mockResolvedValue(stuckStudies);
    mockClient.patchPage
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValueOnce({});

    const result = await sweepStuckImportMode(mockClient, 'db-studies');

    // Should have attempted both — one succeeded, one failed
    expect(result).toEqual({ studiesFound: 2, studiesReset: 1 });
    expect(mockClient.patchPage).toHaveBeenCalledTimes(2);

    // Verify per-study error was logged
    const errorCall = console.error.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('study-fail'),
    );
    expect(errorCall).toBeTruthy();

    // Verify summary log reflects partial success
    const logCall = console.log.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('import_mode_sweep'),
    );
    const logged = JSON.parse(logCall[0]);
    expect(logged).toEqual({ event: 'import_mode_sweep', studiesFound: 2, studiesReset: 1 });
  });
});
