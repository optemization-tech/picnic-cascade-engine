/**
 * Startup boot step: resolves each integration token's bot user ID via
 * GET /v1/users/me and registers it so classifyWebhookActor can fall back
 * to the KNOWN_BOT_IDS allowlist when source.type is absent from a webhook.
 *
 * Runs once after app.listen() resolves. Non-blocking — the server accepts
 * webhooks immediately. The cold-boot guard in actor-classifier.js keeps
 * cascades safe during the registration race.
 *
 * Per-token retry: each /users/me call retries up to 3 times with
 * exponential backoff (1s, 2s, 4s) before giving up. Final per-token
 * failures don't throw — Promise.allSettled isolates them so a single bad
 * token doesn't block the others from registering.
 *
 * Permanent failure alert: if any tokens remain failed after retries, a
 * `bot_ids_registration_permanent_failure` event is emitted with the
 * configured mention user ids (from COMMENT_ERROR_MENTION_IDS) so ops can
 * route alerts through Railway/log-aggregator @-mention rendering — same
 * pattern as failed-inception alerts. Engine echoes from unregistered
 * tokens would misclassify as `'person'` post-cold-boot, risking cascade
 * loops; the alert tells operators to fix the affected tokens and restart.
 *
 * Plan: docs/plans/2026-05-12-001-fix-classify-webhook-actor-edit-first-knownbots-fallback-plan.md (U1 + R2 risk mitigation)
 */

import { registerBotId } from '../notion/actor-classifier.js';
import { NOTION_BASE, NOTION_VERSION } from '../notion/client.js';

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Resolves a single token's bot user id with retry-with-backoff. Returns
 * the id on success; throws on permanent failure after all retries are
 * exhausted. The error carries a `attempts` field so the caller can
 * report which tokens needed retries.
 */
async function resolveBotIdWithRetry(token, {
  maxAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(`${NOTION_BASE}/users/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`/users/me returned ${response.status}`);
      const data = await response.json();
      if (!data.id) throw new Error('/users/me returned ok but response has no id field');
      return data.id;
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === maxAttempts - 1;
      if (!isLastAttempt) {
        await sleepImpl(retryDelaysMs[attempt] ?? retryDelaysMs[retryDelaysMs.length - 1]);
      }
    }
  }
  const err = new Error(`registerBotId permanent failure after ${maxAttempts} attempts: ${lastErr?.message || lastErr}`);
  err.cause = lastErr;
  err.attempts = maxAttempts;
  throw err;
}

/**
 * @param {string[]} tokens  Deduplicated integration tokens across all pools.
 * @param {object} [options]
 * @param {string[]} [options.mentionUserIds]  User ids to include in the alert payload
 *   on permanent failure. Sourced from config.comment.errorMentionIds (Meg/Seb/Tem
 *   typically) so Railway/log-aggregator alerting can @-mention them.
 * @returns {Promise<{ registered: number, failed: number, permanentFailures: number[] }>}
 */
export async function registerBotIds(tokens, { mentionUserIds = [], ...retryOpts } = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.log(JSON.stringify({ event: 'bot_ids_registered', registered: 0, failed: 0 }));
    return { registered: 0, failed: 0, permanentFailures: [] };
  }

  const results = await Promise.allSettled(
    tokens.map(async (token, index) => {
      const id = await resolveBotIdWithRetry(token, retryOpts);
      registerBotId(id);
      return { index, id };
    }),
  );

  const registered = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  const permanentFailures = results
    .map((r, i) => (r.status === 'rejected' ? i : null))
    .filter((x) => x !== null);

  console.log(JSON.stringify({ event: 'bot_ids_registered', registered, failed }));

  // Alert on permanent failures — mirrors the failed-inception alert pattern
  // (mention user ids carried in the payload so log-aggregator alerting can
  // render @-mentions for Meg/Seb/Tem). No Notion page context to comment on
  // at boot, so we surface via structured log + ops-side alert rules.
  if (failed > 0) {
    console.error(JSON.stringify({
      event: 'bot_ids_registration_permanent_failure',
      failedTokenIndices: permanentFailures,
      attemptsExhausted: DEFAULT_RETRY_ATTEMPTS,
      mentionUserIds,
      severity: 'high',
      message: `${failed} of ${tokens.length} Notion integration tokens failed to register their bot user IDs after ${DEFAULT_RETRY_ATTEMPTS} attempts. Engine echoes from these bots will misclassify as user edits, potentially causing cascade loops once the cold-boot guard releases. Fix the affected tokens (check Railway env vars + Notion integration status) and restart the engine.`,
    }));
  }

  return { registered, failed, permanentFailures };
}
