import { registerBotId } from '../notion/actor-classifier.js';

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * Resolve the bot user ID for each integration token by calling /v1/users/me,
 * then register each ID so classifyWebhookActor can fall back to the allowlist
 * when source.type is absent from a webhook payload.
 *
 * Non-blocking: failures for individual tokens are tolerated.
 * Never throws — all errors are contained by Promise.allSettled.
 *
 * @param {string[]} tokens  All integration tokens across all pools.
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
      if (data.id) registerBotId(data.id);
      return data.id;
    }),
  );

  const registered = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(JSON.stringify({ event: 'bot_ids_registered', registered, failed }));
  return { registered, failed };
}
