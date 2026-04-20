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

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  cascadeDebounceMs: parseInt(process.env.CASCADE_DEBOUNCE_MS || '5000', 10),
  sweepGraceMs: parseInt(process.env.SWEEP_GRACE_MS || '45000', 10),
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
