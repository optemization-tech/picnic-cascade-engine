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

    const result = await registerBotIds(['token-a', 'token-b']);

    expect(result).toEqual({ registered: 2, failed: 0 });
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

    const result = await registerBotIds(['token-a', 'token-b', 'token-c']);

    expect(result).toEqual({ registered: 2, failed: 1 });
    expect(registerBotId).toHaveBeenCalledTimes(2);
    expect(registerBotId).toHaveBeenCalledWith('bot-1');
    expect(registerBotId).toHaveBeenCalledWith('bot-3');
  });

  it('resolves without throwing when all tokens fail', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(500));

    const result = await registerBotIds(['token-a', 'token-b', 'token-c']);

    expect(result).toEqual({ registered: 0, failed: 3 });
    expect(registerBotId).not.toHaveBeenCalled();

    const logCall = console.log.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('bot_ids_registered'),
    );
    expect(JSON.parse(logCall[0])).toEqual({ event: 'bot_ids_registered', registered: 0, failed: 3 });
  });

  it('returns immediately with no fetch calls when token array is empty', async () => {
    const result = await registerBotIds([]);

    expect(result).toEqual({ registered: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(registerBotId).not.toHaveBeenCalled();
  });

  it('counts timeout as a failure and registers remaining tokens', async () => {
    const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    fetchMock
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(makeOkResponse('bot-2'));

    const result = await registerBotIds(['token-a', 'token-b']);

    expect(result).toEqual({ registered: 1, failed: 1 });
    expect(registerBotId).toHaveBeenCalledWith('bot-2');
  });

  it('calls registerBotId twice when two tokens return the same ID (Set dedup is in actor-classifier)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse('same-bot'))
      .mockResolvedValueOnce(makeOkResponse('same-bot'));

    const result = await registerBotIds(['token-a', 'token-b']);

    // Both calls succeeded — registered count reflects API call results
    expect(result).toEqual({ registered: 2, failed: 0 });
    // registerBotId called twice; the Set in actor-classifier deduplicates
    expect(registerBotId).toHaveBeenCalledTimes(2);
    expect(registerBotId).toHaveBeenCalledWith('same-bot');
  });
});
