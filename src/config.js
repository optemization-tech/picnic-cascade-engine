// Load .env in development
if (process.env.NODE_ENV !== 'production') {
  const { config } = await import('dotenv');
  config();
}

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// Collect tokens with a given prefix: NOTION_TOKEN, NOTION_PROVISION_TOKEN, etc.
function collectTokens(prefix = 'NOTION_TOKEN') {
  const tokens = [];
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`${prefix}_${i}`];
    if (token) tokens.push(token);
  }
  return tokens;
}

function collectTokensRequired(prefix = 'NOTION_TOKEN') {
  const tokens = collectTokens(prefix);
  if (tokens.length === 0) throw new Error(`At least one ${prefix}_* is required`);
  return tokens;
}

// Production safety: WEBHOOK_SECRET is load-bearing for cascade integrity.
// The bot-authored gate at cascadeQueue.enqueue() suppresses incoming
// webhooks based on a payload field (data.last_edited_by.type), which is
// attacker-controlled if the auth boundary doesn't hold. The webhook auth
// middleware (src/middleware/webhook-auth.js:16) is permissive when
// WEBHOOK_SECRET is unset — fine for local dev / tests, dangerous in
// production. Fail fast at boot rather than ship a silently unauthenticated
// production deploy where an attacker could craft last_edited_by.type='bot'
// to silence cascades for any task.
//
// Strength check: trim and require ≥16 chars so an accidental whitespace-only
// secret (`' '`), a sentinel like `'changeme'`, or a 1-2-char placeholder
// can't satisfy the assertion. 16 chars is roughly 96 bits of entropy when
// random and aligns with HMAC-secret hygiene minimums.
//
// Plan: docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md (U1 step 6).
const MIN_WEBHOOK_SECRET_LENGTH = 16;
if (process.env.NODE_ENV === 'production') {
  const trimmedSecret = process.env.WEBHOOK_SECRET?.trim();
  if (!trimmedSecret || trimmedSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(
      `WEBHOOK_SECRET must be set to a value of at least ${MIN_WEBHOOK_SECRET_LENGTH} ` +
      'characters (after trim) when NODE_ENV=production. The cascade-queue ' +
      'bot-authored gate is load-bearing for cascade integrity; without a ' +
      'real WEBHOOK_SECRET, src/middleware/webhook-auth.js skips auth and an ' +
      'unauthenticated caller could craft last_edited_by.type=bot to silence ' +
      'cascades for any task.'
    );
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  cascadeDebounceMs: parseInt(process.env.CASCADE_DEBOUNCE_MS || '5000', 10),
  comment: {
    errorMentionIds: (process.env.COMMENT_ERROR_MENTION_IDS || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
  },
  notion: {
    // Cascade pool — date-cascade, status-rollup (user-facing, latency-sensitive)
    tokens: collectTokensRequired('NOTION_TOKEN'),
    // Provisioning pool — inception, add-task-set, copy-blocks (bulk operations)
    provisionTokens: collectTokens('NOTION_PROVISION_TOKEN'),
    // Deletion pool — destructive dev utility (fully isolated)
    deletionTokens: collectTokens('NOTION_DELETION_TOKEN'),
    // Comment pool — dedicated integration for study page comments (distinct identity)
    commentTokens: collectTokens('NOTION_COMMENT_TOKEN'),
    studyTasksDbId: required('STUDY_TASKS_DB_ID'),
    studiesDbId: required('STUDIES_DB_ID'),
    blueprintDbId: process.env.BLUEPRINT_DB_ID || null,
    activityLogDbId: process.env.ACTIVITY_LOG_DB_ID || null,
  },
};
