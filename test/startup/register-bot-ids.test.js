import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBotIds } from '../../src/startup/register-bot-ids.js';

vi.mock('../../src/notion/actor-classifier.js', () => ({
  registerBotId: vi.fn(),
}));

// Import after mock so we get the mocked version.
import { registerBotId } from '../../src/notion/actor-classifier.js';

function makeOkResponse(id) {
  return {
    ok: true,
    json: async () => ({ id, type: 'bot' }),
  };
}

function makeErrorResponse(status) {
  return { ok: false, status };
}

// Existing tests pass maxAttempts: 1 to skip retry behavior — those tests
// verify the orchestration shape, not the retry-with-backoff logic. The
// retry-specific tests below cover that path explicitly.
const NO_RETRY = { maxAttempts: 1 };
// Tests that DO exercise the retry path use these zero-delay opts so the
// suite doesn't sit waiting for backoff sleeps.
const FAST_RETRY = { maxAttempts: 3, retryDelaysMs: [0, 0, 0] };

describe('registerBotIds', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('registers all bot IDs and logs summary when all tokens succeed', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse('bot-1'))
      .mockResolvedValueOnce(makeOkResponse('bot-2'));

    const result = await registerBotIds(['token-a', 'token-b'], NO_RETRY);

    expect(result).toMatchObject({ registered: 2, failed: 0, permanentFailures: [] });
    expect(registerBotId).toHaveBeenCalledTimes(2);
    expect(registerBotId).toHaveBeenCalledWith('bot-1');
    expect(registerBotId).toHaveBeenCalledWith('bot-2');

    const logCall = console.log.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('bot_ids_registered'),
    );
    expect(logCall).toBeTruthy();
    expect(JSON.parse(logCall[0])).toEqual({ event: 'bot_ids_registered', registered: 2, failed: 0 });
  });

  it('counts failed token and continues registering remaining bots', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse('bot-1'))
      .mockResolvedValueOnce(makeErrorResponse(401))
      .mockResolvedValueOnce(makeOkResponse('bot-3'));

    const result = await registerBotIds(['token-a', 'token-b', 'token-c'], NO_RETRY);

    expect(result).toMatchObject({ registered: 2, failed: 1, permanentFailures: [1] });
    expect(registerBotId).toHaveBeenCalledTimes(2);
    expect(registerBotId).toHaveBeenCalledWith('bot-1');
    expect(registerBotId).toHaveBeenCalledWith('bot-3');
  });

  it('resolves without throwing when all tokens fail', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(500));

    const result = await registerBotIds(['token-a', 'token-b', 'token-c'], NO_RETRY);

    expect(result).toMatchObject({ registered: 0, failed: 3, permanentFailures: [0, 1, 2] });
    expect(registerBotId).not.toHaveBeenCalled();

    const logCall = console.log.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('bot_ids_registered'),
    );
    expect(JSON.parse(logCall[0])).toEqual({ event: 'bot_ids_registered', registered: 0, failed: 3 });
  });

  it('returns immediately with no fetch calls when token array is empty', async () => {
    const result = await registerBotIds([]);

    expect(result).toMatchObject({ registered: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(registerBotId).not.toHaveBeenCalled();

    const logCall = console.log.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('bot_ids_registered'),
    );
    expect(JSON.parse(logCall[0])).toEqual({ event: 'bot_ids_registered', registered: 0, failed: 0 });
  });

  it('counts timeout as a failure and registers remaining tokens', async () => {
    const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    fetchMock
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(makeOkResponse('bot-2'));

    const result = await registerBotIds(['token-a', 'token-b'], NO_RETRY);

    expect(result).toMatchObject({ registered: 1, failed: 1 });
    expect(registerBotId).toHaveBeenCalledWith('bot-2');
  });

  it('counts as failed when 200 response has no id field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ type: 'bot' }),
    });

    const result = await registerBotIds(['token-a'], NO_RETRY);

    expect(result).toMatchObject({ registered: 0, failed: 1 });
    expect(registerBotId).not.toHaveBeenCalled();
  });

  it('calls registerBotId twice when two tokens return the same ID (Set dedup is in actor-classifier)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse('same-bot'))
      .mockResolvedValueOnce(makeOkResponse('same-bot'));

    const result = await registerBotIds(['token-a', 'token-b'], NO_RETRY);

    expect(result).toMatchObject({ registered: 2, failed: 0 });
    expect(registerBotId).toHaveBeenCalledTimes(2);
    expect(registerBotId).toHaveBeenCalledWith('same-bot');
  });

  // ─── Retry-with-backoff ─────────────────────────────────────────────────

  describe('retry-with-backoff', () => {
    it('retries a transient failure and succeeds on attempt 2', async () => {
      fetchMock
        .mockResolvedValueOnce(makeErrorResponse(500))
        .mockResolvedValueOnce(makeOkResponse('bot-1'));

      const result = await registerBotIds(['token-a'], FAST_RETRY);
      expect(result).toMatchObject({ registered: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(registerBotId).toHaveBeenCalledWith('bot-1');
    });

    it('exhausts all 3 attempts on persistent failure and reports permanent failure', async () => {
      fetchMock.mockResolvedValue(makeErrorResponse(500));

      const result = await registerBotIds(['token-a'], FAST_RETRY);
      expect(result).toMatchObject({ registered: 0, failed: 1, permanentFailures: [0] });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('emits bot_ids_registration_permanent_failure with mention user ids on permanent failure', async () => {
      fetchMock.mockResolvedValue(makeErrorResponse(401));

      await registerBotIds(['bad-token'], {
        ...FAST_RETRY,
        mentionUserIds: ['meg-user-id', 'seb-user-id', 'tem-user-id'],
      });

      const errorCall = console.error.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('bot_ids_registration_permanent_failure'),
      );
      expect(errorCall).toBeTruthy();
      const payload = JSON.parse(errorCall[0]);
      expect(payload).toMatchObject({
        event: 'bot_ids_registration_permanent_failure',
        failedTokenIndices: [0],
        attemptsExhausted: 3,
        mentionUserIds: ['meg-user-id', 'seb-user-id', 'tem-user-id'],
        severity: 'high',
      });
    });

    it('does NOT emit the permanent-failure alert when all tokens succeed (no false alarms)', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse('bot-1'));

      await registerBotIds(['token-a'], { ...FAST_RETRY, mentionUserIds: ['meg-user-id'] });

      const errorCall = console.error.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('bot_ids_registration_permanent_failure'),
      );
      expect(errorCall).toBeFalsy();
    });
  });
});
