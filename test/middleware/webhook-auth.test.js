import { describe, expect, it, vi } from 'vitest';
import { createWebhookAuthMiddleware } from '../../src/middleware/webhook-auth.js';

function makeReq(headerValue) {
  return {
    get: vi.fn((name) => (name === 'X-Webhook-Secret' ? headerValue : undefined)),
  };
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

describe('webhook auth middleware', () => {
  it('allows requests when no secret is configured', () => {
    const middleware = createWebhookAuthMiddleware({ webhookSecret: null });
    const next = vi.fn();

    middleware(makeReq(undefined), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects requests with missing secret', () => {
    const middleware = createWebhookAuthMiddleware({ webhookSecret: 'top-secret' });
    const res = makeRes();
    const next = vi.fn();

    middleware(makeReq(undefined), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows requests with matching secret', () => {
    const middleware = createWebhookAuthMiddleware({ webhookSecret: 'top-secret' });
    const next = vi.fn();

    middleware(makeReq('top-secret'), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
