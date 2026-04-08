const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

export function webhookAuth(req, res, next) {
  if (!WEBHOOK_SECRET) return next(); // skip in dev if unset
  if (req.headers['x-webhook-secret'] === WEBHOOK_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
