import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

function getArg(name, fallback = null) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function usageAndExit(message = '') {
  if (message) console.error(message);
  console.error('Usage: npm run fire:date-webhook -- --task <pageId> [--url <endpoint>] [--token <notion_token>]');
  console.error('Default url: http://localhost:3000/webhook/date-cascade');
  process.exit(1);
}

const pageId = getArg('task');
const url = getArg('url', 'http://localhost:3000/webhook/date-cascade');
const token = getArg('token', process.env.NOTION_TOKEN_1);

if (!pageId) usageAndExit('Missing required --task');
if (!token) usageAndExit('Missing Notion token (use --token or set NOTION_TOKEN_1)');

const notionResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
  },
});

if (!notionResp.ok) {
  const text = await notionResp.text();
  console.error(`Notion GET failed: ${notionResp.status} ${notionResp.statusText}`);
  console.error(text);
  process.exit(1);
}

const page = await notionResp.json();
const payload = {
  body: {
    data: {
      id: page.id,
      properties: page.properties || {},
      last_edited_by: page.last_edited_by || null,
    },
  },
};

const webhookResp = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(process.env.WEBHOOK_SECRET ? { 'X-Webhook-Secret': process.env.WEBHOOK_SECRET } : {}),
  },
  body: JSON.stringify(payload),
});

if (!webhookResp.ok) {
  const text = await webhookResp.text();
  console.error(`Webhook call failed: ${webhookResp.status} ${webhookResp.statusText}`);
  console.error(text);
  process.exit(1);
}

const text = await webhookResp.text();
console.log(`Webhook fired for task ${pageId} -> ${url}`);
console.log(`Response: ${text || '(empty)'}`);
