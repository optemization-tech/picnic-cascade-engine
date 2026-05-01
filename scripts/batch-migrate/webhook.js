/**
 * Engine webhook helpers — POST /webhook/inception, POST /webhook/migrate-study.
 *
 * Both endpoints are documented in:
 *   - src/routes/inception.js
 *   - src/routes/migrate-study.js
 *   - docs/MIGRATE-STUDY-WEBHOOK.md
 *
 * Auth: X-Webhook-Secret header matching Railway WEBHOOK_SECRET env.
 * Both endpoints respond 200 immediately; processing continues async.
 * Use poll.js to detect terminal state.
 */

export async function fireInception(engineUrl, secret, productionStudyId) {
  return fireWebhook(engineUrl, secret, '/webhook/inception', {
    data: { id: productionStudyId },
  });
}

export async function fireMigrateStudy(engineUrl, secret, exportedStudyRowId) {
  return fireWebhook(engineUrl, secret, '/webhook/migrate-study', {
    data: { id: exportedStudyRowId },
  });
}

async function fireWebhook(engineUrl, secret, path, payload) {
  const url = `${engineUrl.replace(/\/$/, '')}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Webhook-Secret': secret } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`Webhook ${path} failed: ${resp.status} ${resp.statusText}\n${text}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  return { ok: true, status: resp.status, body: text };
}
