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
  console.error('Usage: npm run patch:task-date -- --task <pageId> --start <YYYY-MM-DD> [--end <YYYY-MM-DD>] [--token <notion_token>]');
  process.exit(1);
}

const pageId = getArg('task');
const start = getArg('start');
const end = getArg('end', start);
const token = getArg('token', process.env.NOTION_TOKEN_1);

if (!pageId) usageAndExit('Missing required --task');
if (!start) usageAndExit('Missing required --start');
if (!token) usageAndExit('Missing Notion token (use --token or set NOTION_TOKEN_1)');

const body = {
  properties: {
    Dates: {
      date: { start, end },
    },
  },
};

const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

if (!response.ok) {
  const text = await response.text();
  console.error(`Notion PATCH failed: ${response.status} ${response.statusText}`);
  console.error(text);
  process.exit(1);
}

console.log(`Patched task ${pageId} Dates to ${start} -> ${end}`);
