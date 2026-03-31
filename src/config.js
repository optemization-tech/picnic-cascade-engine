import { config as dotenvConfig } from 'dotenv';

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

// Collect all NOTION_TOKEN_* env vars for token rotation
function collectTokens() {
  const tokens = [];
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`NOTION_TOKEN_${i}`];
    if (token) tokens.push(token);
  }
  if (tokens.length === 0) throw new Error('At least one NOTION_TOKEN_* is required');
  return tokens;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  notion: {
    tokens: collectTokens(),
    studyTasksDbId: required('STUDY_TASKS_DB_ID'),
    studiesDbId: required('STUDIES_DB_ID'),
  },
  activityLogWebhookUrl: process.env.ACTIVITY_LOG_WEBHOOK_URL || null,
};
