// Humanize Notion API errors for PM-facing surfaces (study-page comments,
// Automation Reporting field, Activity Log Summary). Raw Notion messages
// are long and leak internal UUIDs; this produces a short, readable form.
//
// Debugging surfaces (Activity Log Details code block, Railway logs) keep
// the raw error -- humanize is only for human-readable text.

// Database/data-source IDs (dash and no-dash forms both supported by
// normalizeUuid). Keep in sync with env vars in src/config.js when a new
// database is added to the engine's surface area.
const DATABASE_NAMES = new Map([
  ['40f2386760c2830eaad68159ca69a8d6', 'Study Tasks'],
  ['eb82386760c283a6b06707cd54089367', 'Study Tasks'],
  ['cad2386760c2836fa27d0131c25b6dcd', 'Studies'],
  ['17d2386760c28337b79507ddf3b79c4f', 'Studies'],
  ['8fe2386760c283e9a95d01ade939f5c2', 'Study Blueprint'],
  ['6862386760c282c4a494075c33c8d88d', 'Study Blueprint'],
  ['f512386760c282269d66810554f3ec81', 'Activity Log'],
  ['ba42386760c282c385408737ba4f730d', 'Activity Log'],
]);

function normalizeUuid(raw) {
  return String(raw || '').replace(/-/g, '').toLowerCase();
}

export function lookupDatabaseName(uuid) {
  return DATABASE_NAMES.get(normalizeUuid(uuid)) || null;
}

export function humanizeNotionError(error) {
  const raw = String(error?.message || error || 'Unknown error');

  // 404 not-shared: "Notion API 404 Not Found: Could not find <object> with
  // ID: <uuid>. Make sure the relevant pages and databases are shared with
  // your integration \"X\"."
  const notFound = raw.match(/Could not find (database|page|block) with ID:\s*([0-9a-f-]{32,36})/i);
  const integration = raw.match(/integration\s*["']([^"']+)["']/i);
  if (notFound && integration) {
    const objectType = notFound[1];
    const dbName = lookupDatabaseName(notFound[2]);
    const subject = dbName ? `${dbName} ${objectType}` : `A ${objectType}`;
    return `${subject} is not shared with integration "${integration[1]}".`;
  }

  return raw;
}
