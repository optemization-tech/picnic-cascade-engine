/**
 * One-time migration: compute and write Relative SDate Offset / Relative EDate Offset
 * on all subtasks in the V2 Blueprint database.
 *
 * Formula:
 *   relative_soff = signedBDDelta(parentAbsStart, subtaskAbsStart)
 *   relative_eoff = signedBDDelta(parentAbsStart, subtaskAbsEnd)
 *
 * Where absolute dates = addBusinessDays(anchor, globalOffset)
 * Anchor = 2027-01-01 (matching Blueprint formulas)
 *
 * Usage: node scripts/migrate-relative-offsets.js
 */

import 'dotenv/config';
import { parseDate, addBusinessDays, signedBDDelta, formatDate } from '../src/utils/business-days.js';

const BLUEPRINT_DB_ID = process.env.BLUEPRINT_V2_DB_ID || '08b23867-60c2-837b-8d9e-01b5fac3682e';
const TOKEN = process.env.NOTION_TOKEN_1;
const ANCHOR = parseDate('2027-01-01');

if (!TOKEN) {
  console.error('Missing NOTION_TOKEN_1 env var');
  process.exit(1);
}

async function notionRequest(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function queryAll(dbId) {
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest('POST', `/databases/${dbId}/query`, body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function extractTask(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: p['Task Name']?.title?.[0]?.plain_text || page.id.substring(0, 8),
    parentId: (p['Parent Task']?.relation || [])[0]?.id || null,
    soff: p['SDate Offset']?.number,
    eoff: p['EDate Offset']?.number,
    existingRelSoff: p['Relative SDate Offset']?.number ?? null,
    existingRelEoff: p['Relative EDate Offset']?.number ?? null,
  };
}

async function main() {
  console.log(`Querying V2 Blueprint DB: ${BLUEPRINT_DB_ID}`);
  const pages = await queryAll(BLUEPRINT_DB_ID);
  console.log(`Total tasks: ${pages.length}`);

  const tasks = pages.map(extractTask);
  const parents = new Map();
  const subtasks = [];

  for (const t of tasks) {
    if (!t.parentId) {
      parents.set(t.id, t);
    } else {
      subtasks.push(t);
    }
  }

  console.log(`Parents: ${parents.size}, Subtasks: ${subtasks.length}`);

  // Compute relative offsets
  const patches = [];
  const skipped = [];

  for (const sub of subtasks) {
    const parent = parents.get(sub.parentId);
    if (!parent) {
      skipped.push({ name: sub.name, reason: 'parent not found' });
      continue;
    }
    if (sub.soff == null || sub.eoff == null || parent.soff == null) {
      skipped.push({ name: sub.name, reason: 'missing offsets' });
      continue;
    }

    // Convert global calendar offsets to absolute business-day dates
    const parentAbsStart = addBusinessDays(ANCHOR, parent.soff);
    const subtaskAbsStart = addBusinessDays(ANCHOR, sub.soff);
    const subtaskAbsEnd = addBusinessDays(ANCHOR, sub.eoff);

    // Compute BD delta from parent start to subtask start/end
    const relativeSoff = signedBDDelta(parentAbsStart, subtaskAbsStart);
    const relativeEoff = signedBDDelta(parentAbsStart, subtaskAbsEnd);

    patches.push({
      id: sub.id,
      name: sub.name,
      parentName: parent.name,
      globalSoff: sub.soff,
      globalEoff: sub.eoff,
      parentSoff: parent.soff,
      relativeSoff,
      relativeEoff,
      parentAbsStart: formatDate(parentAbsStart),
      subtaskAbsStart: formatDate(subtaskAbsStart),
      subtaskAbsEnd: formatDate(subtaskAbsEnd),
    });
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} subtasks:`);
    for (const s of skipped) console.log(`  - ${s.name}: ${s.reason}`);
  }

  console.log(`\nPatching ${patches.length} subtasks...`);

  // Batch patch with rate limiting (3 per second)
  let patched = 0;
  const BATCH_SIZE = 3;
  const BATCH_INTERVAL = 1100; // ms

  for (let i = 0; i < patches.length; i += BATCH_SIZE) {
    const batch = patches.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((p) =>
        notionRequest('PATCH', `/pages/${p.id}`, {
          properties: {
            'Relative SDate Offset': { number: p.relativeSoff },
            'Relative EDate Offset': { number: p.relativeEoff },
          },
        }),
      ),
    );
    patched += batch.length;
    if (patched % 30 === 0 || patched === patches.length) {
      console.log(`  ${patched}/${patches.length} patched`);
    }
    if (i + BATCH_SIZE < patches.length) {
      await new Promise((r) => setTimeout(r, BATCH_INTERVAL));
    }
  }

  // Verification: spot-check 5 subtasks
  console.log('\n=== VERIFICATION (spot-check 5) ===');
  const spotCheck = patches.slice(0, 5);
  for (const p of spotCheck) {
    const page = await notionRequest('GET', `/pages/${p.id}`);
    const relSoff = page.properties['Relative SDate Offset']?.number;
    const relEoff = page.properties['Relative EDate Offset']?.number;
    const match = relSoff === p.relativeSoff && relEoff === p.relativeEoff;
    console.log(
      `  ${match ? '✓' : '✗'} ${p.name} (parent: ${p.parentName})` +
        ` | relSoff=${relSoff} (expected ${p.relativeSoff})` +
        ` | relEoff=${relEoff} (expected ${p.relativeEoff})` +
        ` | parentStart=${p.parentAbsStart} subtaskStart=${p.subtaskAbsStart} subtaskEnd=${p.subtaskAbsEnd}`,
    );
  }

  // Summary stats
  console.log('\n=== SUMMARY ===');
  console.log(`Total subtasks: ${subtasks.length}`);
  console.log(`Patched: ${patched}`);
  console.log(`Skipped: ${skipped.length}`);

  const zeroSoff = patches.filter((p) => p.relativeSoff === 0).length;
  const negativeSoff = patches.filter((p) => p.relativeSoff < 0).length;
  console.log(`Zero relative soff (starts at parent start): ${zeroSoff}`);
  console.log(`Negative relative soff (ERROR — subtask before parent): ${negativeSoff}`);
  if (negativeSoff > 0) {
    console.log('WARNING: subtasks with negative relative offsets need investigation:');
    for (const p of patches.filter((p) => p.relativeSoff < 0)) {
      console.log(`  ${p.name} (parent: ${p.parentName}): relSoff=${p.relativeSoff}, parentSoff=${p.parentSoff}, globalSoff=${p.globalSoff}`);
    }
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
