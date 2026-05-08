/**
 * Startup boot step: resolves each integration token's bot user ID via
 * GET /v1/users/me and registers it so classifyWebhookActor can fall back
 * to the KNOWN_BOT_IDS allowlist when source.type is absent from a webhook.
 *
 * Runs once after app.listen() resolves. Non-blocking — the server accepts
 * webhooks immediately. Never throws — all per-token errors are contained
 * by Promise.allSettled.
 */

import { registerBotId } from '../notion/actor-classifier.js';
import { NOTION_BASE, NOTION_VERSION } from '../notion/client.js';

/**
 * @param {string[]} tokens  Deduplicated integration tokens across all pools.
 * @returns {Promise<{ registered: number, failed: number }>}
 */
export async function registerBotIds(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.log(JSON.stringify({ event: 'bot_ids_registered', registered: 0, failed: 0 }));
    return { registered: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const response = await fetch(`${NOTION_BASE}/users/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`/users/me returned ${response.status}`);
      const data = await response.json();
      if (!data.id) throw new Error('/users/me returned ok but response has no id field');
      registerBotId(data.id);
      return data.id;
    }),
  );

  const registered = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(JSON.stringify({ event: 'bot_ids_registered', registered, failed }));
  return { registered, failed };
}
