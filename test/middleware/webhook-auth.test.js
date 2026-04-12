import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('webhookAuth middleware', () => {
  let webhookAuth;
  const originalEnv = process.env.WEBHOOK_SECRET;

  beforeEach(() => {
    // Clear module cache so env is re-read
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.WEBHOOK_SECRET = originalEnv;
    } else {
      delete process.env.WEBHOOK_SECRET;
    }
  });

  function makeMocks(headerValue) {
    const req = { headers: {} };
    if (headerValue !== undefined) req.headers['x-webhook-secret'] = headerValue;
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    return { req, res, next };
  }

  it('skips auth when WEBHOOK_SECRET is not configured', async () => {
    delete process.env.WEBHOOK_SECRET;
    const mod = await import('../../src/middleware/webhook-auth.js');
    webhookAuth = mod.webhookAuth;
    const { req, res, next } = makeMocks();
    webhookAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows request with valid secret', async () => {
    process.env.WEBHOOK_SECRET = 'test-secret-123';
    const mod = await import('../../src/middleware/webhook-auth.js');
    webhookAuth = mod.webhookAuth;
    const { req, res, next } = makeMocks('test-secret-123');
    webhookAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects request with invalid secret', async () => {
    process.env.WEBHOOK_SECRET = 'test-secret-123';
    const mod = await import('../../src/middleware/webhook-auth.js');
    webhookAuth = mod.webhookAuth;
    const { req, res, next } = makeMocks('wrong-secret');
    webhookAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('rejects request with missing secret header', async () => {
    process.env.WEBHOOK_SECRET = 'test-secret-123';
    const mod = await import('../../src/middleware/webhook-auth.js');
    webhookAuth = mod.webhookAuth;
    const { req, res, next } = makeMocks();
    webhookAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
