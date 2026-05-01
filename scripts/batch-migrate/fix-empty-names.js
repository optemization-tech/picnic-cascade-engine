#!/usr/bin/env node
/**
 * Group C cleanup: PATCH `Name` (title) on Asana Exported Tasks rows that
 * came in with empty titles because the source per-study migrated DB used a
 * different title-column name (Priority, Risk level, etc.).
 *
 * Notion's move-page preserves title CONTENT regardless of source title-name
 * — but only when the source title actually held the task name. Group C
 * studies have their TITLE column holding *non-name* content (priority
 * codes / risk labels) and the actual task name lives in a separate
 * rich_text column (typically `Task`). After move, dest `Name` is empty.
 *
 * Strategy:
 *   1. Query Asana Exported Tasks where Study relation = <given> AND title is empty
 *   2. For each row, fall back through a per-study list of rich_text source
 *      columns and use the first one that has content
 *   3. PATCH `Name` (title) with that text
 *
 * Optionally re-fires the Migrator webhook after the patches.
 *
 * Usage:
 *   node scripts/batch-migrate/fix-empty-names.js \
 *     --study ionis-hae-001 [--re-fire-migrator] [--dry-run]
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import {
  queryDb,
  patchPage,
  prop,
  readTitle,
  readRichText,
} from './notion.js';
import { fireMigrateStudy } from './webhook.js';
import { ENGINE_CONFIG } from './config.js';

// Per-study fallback chain for the title source.
// Order matters — first non-empty rich_text wins.
// Group C studies whose per-study migrated DB had its title-column named
// something other than the canonical task-name field (e.g., Priority, Risk
// level). Post-move, dest `Name` came in empty because the source title
// content was empty/garbage; the actual task names sit in a `Task` rich_text
// column the move auto-created on Asana Exported Tasks.
//
// Ipsen PBC 001 is intentionally NOT in this list — its source title was
// named `Task` and carried correct names into dest `Name` automatically.
const TITLE_FALLBACKS = {
  'ionis-hae-001':   { exportedStudyRowId: 'd7e1837d-9a8a-461d-9a0f-af5a3a3d9a90', cols: ['Task', 'Title', 'Subject'] },
  'pfizer-heme-002': { exportedStudyRowId: 'e7c4e4ca-6718-44ba-a294-2048fc618c38', cols: ['Task', 'Title', 'Subject'] },
};

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

const opts = {
  study: getArg('study'),
  reFireMigrator: !!getArg('re-fire-migrator'),
  dryRun: !!getArg('dry-run'),
  token: getArg('token') || process.env.NOTION_TOKEN_1,
  webhookSecret: process.env.WEBHOOK_SECRET,
  engineUrl: getArg('engine-url') || ENGINE_CONFIG.engineUrl,
};

if (!opts.study) {
  console.error('Usage: node scripts/batch-migrate/fix-empty-names.js --study <key> [--re-fire-migrator] [--dry-run]');
  console.error('Available study keys:', Object.keys(TITLE_FALLBACKS).join(', '));
  process.exit(1);
}

const cfg = TITLE_FALLBACKS[opts.study];
if (!cfg) {
  console.error(`No fallback chain configured for ${opts.study}`);
  process.exit(1);
}

(async function main() {
  // Resolve Exported Studies row id if not pre-configured (works post-orchestrator-run).
  let exportedStudyRowId = cfg.exportedStudyRowId;
  if (!exportedStudyRowId) {
    console.error('exportedStudyRowId not pre-configured for', opts.study);
    console.error('  → run with the row id hardcoded into TITLE_FALLBACKS, or extend this script to look it up by study name');
    process.exit(1);
  }

  console.log(`[fix-empty-names] study=${opts.study} exportedStudyRowId=${exportedStudyRowId}`);
  console.log(`[fix-empty-names] fallback rich_text cols: ${cfg.cols.join(' → ')}`);
  console.log(`[fix-empty-names] dry-run: ${opts.dryRun}`);

  const rows = await queryDb(
    ENGINE_CONFIG.asanaExportedTasksDbId,
    {
      filter: {
        property: ENGINE_CONFIG.exportedTaskStudyPropName,
        relation: { contains: exportedStudyRowId },
      },
    },
    { token: opts.token },
  );
  console.log(`[fix-empty-names] candidates in Asana Exported Tasks: ${rows.length}`);

  let patched = 0;
  let skippedAlreadyNamed = 0;
  let skippedNoFallback = 0;

  for (const row of rows) {
    const currentName = readTitle(row, 'Name');
    if (currentName.trim()) {
      skippedAlreadyNamed++;
      continue;
    }

    let chosen = null;
    for (const col of cfg.cols) {
      const text = readRichText(row, col).trim();
      if (text) {
        chosen = { col, text };
        break;
      }
    }

    if (!chosen) {
      skippedNoFallback++;
      continue;
    }

    if (opts.dryRun) {
      console.log(`  [dry-run] ${row.id} ← Name="${chosen.text.slice(0, 60)}" (from ${chosen.col})`);
    } else {
      await patchPage(
        row.id,
        { properties: { Name: prop.title(chosen.text) } },
        { token: opts.token },
      );
    }
    patched++;
    if (!opts.dryRun && patched % 25 === 0) process.stdout.write(`    PATCHed ${patched}\r`);
  }
  process.stdout.write('\n');

  console.log('');
  console.log(`[fix-empty-names] PATCHed: ${patched}`);
  console.log(`[fix-empty-names] skipped (already named): ${skippedAlreadyNamed}`);
  console.log(`[fix-empty-names] skipped (no fallback content): ${skippedNoFallback}`);

  if (opts.reFireMigrator) {
    if (opts.dryRun) {
      console.log(`[fix-empty-names] would POST /webhook/migrate-study with { data: { id: ${exportedStudyRowId} } }`);
    } else {
      console.log(`[fix-empty-names] firing Migrate Study webhook…`);
      await fireMigrateStudy(opts.engineUrl, opts.webhookSecret, exportedStudyRowId);
      console.log(`[fix-empty-names] Migrate Study webhook accepted (200). Watch Production Study Automation Reporting for terminal state.`);
    }
  }
})().catch((err) => {
  console.error('[fix-empty-names] failed:', err.message);
  process.exit(1);
});
