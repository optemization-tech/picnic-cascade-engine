import crypto from 'crypto';

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || '', 'utf8');
  const expectedBuffer = Buffer.from(expected || '', 'utf8');

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createWebhookAuthMiddleware({ webhookSecret }) {
  if (!webhookSecret) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const providedSecret = req.get('X-Webhook-Secret');
    if (!safeEqual(providedSecret, webhookSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
