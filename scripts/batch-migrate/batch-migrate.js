#!/usr/bin/env node
/**
 * Batch-migrate orchestrator — applies the just-shipped Migrate Study pipeline
 * to multiple studies in a single CLI invocation.
 *
 * Plan: docs/plans/2026-04-30-003-feat-batch-migrate-7-studies-plan.md
 *
 * Usage:
 *   node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass --dry-run
 *   node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass
 *   node scripts/batch-migrate/batch-migrate.js --all
 *
 * Required env (loaded from engine .env):
 *   NOTION_TOKEN_1     — Notion integration token with access to source + dest DBs
 *   WEBHOOK_SECRET     — engine webhook X-Webhook-Secret value
 *   MIGRATED_TASKS_DB_ID, MIGRATED_STUDIES_DB_ID, STUDIES_DB_ID, STUDY_TASKS_DB_ID
 *     — fall back to defaults from src/migration/constants.js + .env.example
 *
 * The pipeline per study (idempotent — short-circuits each phase if already done):
 *   1. resolveOrCreateProductionStudy
 *   2. ensureInception (skip if Study Tasks ≥ 100)
 *   3. resolveOrCreateExportedStudiesRow + verify 1:1 round-trip
 *   4. consolidateMigratedTasks (move per-study migrated rows → Asana Exported Tasks)
 *   5. triggerMigrator → poll Automation Reporting for terminal state
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import {
  getPage,
  retrieveDb,
  queryDb,
  search,
  patchPage,
  createPage,
  movePages,
  prop,
  readTitle,
  readRelation,
  readDate,
} from './notion.js';
import { fireInception, fireMigrateStudy } from './webhook.js';
import { pollStudyTasksCount, pollAutomationReporting } from './poll.js';
import { STUDIES, ENGINE_CONFIG, findStudyConfig } from './config.js';

// ─── CLI ────────────────────────────────────────────────────────────────────

function getArg(name, fallback = null) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  // Boolean flag (next arg is missing or starts with --) → true
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

function usage(msg = '') {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage: node scripts/batch-migrate/batch-migrate.js [options]');
  console.error('');
  console.error('  --study <key>            single-study run (e.g., moderna-mma-pa-compass)');
  console.error('  --all                    run every study in scripts/batch-migrate/config.js');
  console.error('  --dry-run                print planned writes; no Notion or webhook traffic');
  console.error('  --skip-create-study      assume Production Study already exists; resolve by name');
  console.error('  --skip-inception         assume Inception already ran; skip the wait');
  console.error('  --skip-migrator          do consolidation only; do not fire /webhook/migrate-study');
  console.error('  --contract-sign <date>   override Contract Sign Date (YYYY-MM-DD)');
  console.error('  --engine-url <url>       override engine base URL');
  console.error('  --token <token>          override NOTION_TOKEN_1');
  console.error('');
  console.error('Available studies:');
  for (const s of STUDIES) console.error(`  ${s.key.padEnd(32)} (Group ${s.group}) ${s.name}`);
  process.exit(msg ? 1 : 0);
}

const opts = {
  study: getArg('study'),
  all: !!getArg('all'),
  dryRun: !!getArg('dry-run'),
  skipCreateStudy: !!getArg('skip-create-study'),
  skipInception: !!getArg('skip-inception'),
  skipMigrator: !!getArg('skip-migrator'),
  contractSign: getArg('contract-sign'),
  engineUrl: getArg('engine-url') || ENGINE_CONFIG.engineUrl,
  token: getArg('token') || process.env.NOTION_TOKEN_1,
  webhookSecret: process.env.WEBHOOK_SECRET,
};

if (!opts.study && !opts.all) usage('--study <key> or --all required');
if (!opts.token) usage('NOTION_TOKEN_1 not set (use --token or .env)');
if (!opts.dryRun && !opts.skipMigrator && !opts.webhookSecret) {
  usage('WEBHOOK_SECRET not set — needed for live webhook calls (or use --skip-migrator / --dry-run)');
}

// ─── Logging helpers ────────────────────────────────────────────────────────

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const phase = (n, name) => log(c.bold(`\n[${n}] ${name}`));
const dryNote = (msg) => log(c.dim(`  [dry-run] ${msg}`));
const ok = (msg) => log(c.green(`  ✓ ${msg}`));
const warn = (msg) => log(c.yellow(`  ⚠ ${msg}`));
const info = (msg) => log(c.cyan(`  • ${msg}`));

// ─── Phase implementations ──────────────────────────────────────────────────

async function resolveExportedStudiesRow(study, ctx) {
  phase(1, `Resolve Exported Studies row + read Contract Start Date`);

  const rows = await queryDb(
    ENGINE_CONFIG.exportedStudiesDbId,
    {
      filter: {
        property: ENGINE_CONFIG.exportedStudyTitlePropName,
        title: { equals: study.name },
      },
    },
    { token: opts.token },
  );

  if (rows.length === 0) {
    throw new Error(
      `No Exported Studies row titled "${study.name}". Create one in https://www.notion.so/picnichealth/${ENGINE_CONFIG.exportedStudiesDbId.replace(/-/g, '')} with Contract Start Date set, then rerun.`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `Found ${rows.length} Exported Studies rows titled "${study.name}" — disambiguate manually.`,
    );
  }

  ctx.exportedStudyRow = rows[0];
  ctx.exportedStudyRowId = rows[0].id;
  info(`Exported Studies row: ${ctx.exportedStudyRowId}`);

  const csd = readDate(rows[0], ENGINE_CONFIG.exportedStudyContractStartDatePropName)?.start;
  if (!csd && !opts.contractSign && !study.contractSignDate) {
    throw new Error(
      `Exported Studies row "${study.name}" has no Contract Start Date — set it on the row, or pass --contract-sign YYYY-MM-DD, then rerun.`,
    );
  }
  ctx.contractSignDate = opts.contractSign || csd || study.contractSignDate;
  info(`Contract Start Date (→ Contract Sign Date for cascade): ${ctx.contractSignDate}`);

  // Capture existing Production Study relation if already wired.
  const existingProdRel = readRelation(rows[0], ENGINE_CONFIG.exportedStudyProductionStudyPropName);
  if (existingProdRel.length === 1) {
    ctx.preexistingProductionStudyId = existingProdRel[0];
    info(`Production Study relation already set on this row → ${existingProdRel[0]}`);
  } else if (existingProdRel.length > 1) {
    throw new Error(
      `Exported Studies row has ${existingProdRel.length} Production Study relations; Migrator gate requires exactly 1.`,
    );
  }
}

async function resolveOrCreateProductionStudy(study, ctx) {
  phase(2, `Resolve / create Production Study: ${study.name}`);

  // Search the cascade Studies DB for an existing row with this title.
  const existing = await queryDb(
    ENGINE_CONFIG.studiesDbId,
    {
      filter: {
        property: ENGINE_CONFIG.studyNamePropName,
        title: { equals: study.name },
      },
    },
    { token: opts.token },
  );

  // Short-circuit if Exported Studies row already has the Production Study relation set.
  if (ctx.preexistingProductionStudyId) {
    const page = await getPage(ctx.preexistingProductionStudyId, { token: opts.token });
    info(`Using pre-wired Production Study: ${ctx.preexistingProductionStudyId}`);
    const csd = readDate(page, ENGINE_CONFIG.studyContractSignDatePropName)?.start;
    if (!csd) {
      info(`pre-wired Production Study has no Contract Sign Date; setting → ${ctx.contractSignDate}`);
      if (opts.dryRun) dryNote(`would PATCH ${page.id} with Contract Sign Date = ${ctx.contractSignDate}`);
      else {
        await patchPage(
          page.id,
          { properties: { [ENGINE_CONFIG.studyContractSignDatePropName]: prop.date(ctx.contractSignDate) } },
          { token: opts.token },
        );
        ok('Contract Sign Date set');
      }
    } else {
      ok(`Contract Sign Date already set: ${csd}`);
    }
    ctx.productionStudyId = ctx.preexistingProductionStudyId;
    ctx.productionStudyExisted = true;
    return;
  }

  if (existing.length === 1) {
    const page = existing[0];
    info(`Production Study already exists: ${page.id}`);

    // Verify Contract Sign Date is set (Inception aborts otherwise).
    const csd = readDate(page, ENGINE_CONFIG.studyContractSignDatePropName)?.start;
    const desiredCsd = opts.contractSign || ctx.contractSignDate || study.contractSignDate;

    if (!csd && !desiredCsd) {
      const msg = `Production Study ${study.name} has no Contract Sign Date and none provided in config / --contract-sign`;
      if (opts.dryRun) {
        warn(`BLOCKER: ${msg}`);
        warn('  → set contractSignDate in config.js or pass --contract-sign YYYY-MM-DD before live run');
      } else {
        throw new Error(msg);
      }
    } else if (!csd) {
      info(`setting Contract Sign Date = ${desiredCsd}`);
      if (opts.dryRun) dryNote(`would PATCH ${page.id} with Contract Sign Date = ${desiredCsd}`);
      else {
        await patchPage(
          page.id,
          { properties: { [ENGINE_CONFIG.studyContractSignDatePropName]: prop.date(desiredCsd) } },
          { token: opts.token },
        );
        ok('Contract Sign Date set');
      }
    } else if (desiredCsd && csd !== desiredCsd) {
      warn(`existing Contract Sign Date ${csd} != requested ${desiredCsd}; keeping existing`);
    }
    ctx.productionStudyId = page.id;
    ctx.productionStudyExisted = true;
    return;
  }

  if (existing.length > 1) {
    throw new Error(
      `Found ${existing.length} cascade Studies rows titled "${study.name}" — disambiguate manually before running.`,
    );
  }

  // Create.
  const desiredCsd = opts.contractSign || ctx.contractSignDate || study.contractSignDate;
  if (opts.skipCreateStudy) {
    throw new Error(
      `--skip-create-study set, but no existing Production Study found for "${study.name}". Create it manually in Notion or drop the flag.`,
    );
  }
  if (!desiredCsd) {
    const msg = `Production Study ${study.name} doesn't exist and no Contract Sign Date provided (set in config.js or pass --contract-sign YYYY-MM-DD)`;
    if (opts.dryRun) {
      warn(`BLOCKER: ${msg}`);
      warn('  → resolve before live run; dry-run continuing with placeholder');
      ctx.productionStudyId = '00000000-0000-0000-0000-000000000000';
      ctx.productionStudyIsPlaceholder = true;
      ctx.productionStudyExisted = false;
      return;
    }
    throw new Error(msg);
  }

  info(`creating Production Study with Contract Sign Date = ${desiredCsd}`);
  if (opts.dryRun) {
    dryNote(`would CREATE row in ${ENGINE_CONFIG.studiesDbId} with title=${study.name}, csd=${desiredCsd}`);
    ctx.productionStudyId = '00000000-0000-0000-0000-000000000000';
    ctx.productionStudyIsPlaceholder = true;
    ctx.productionStudyExisted = false;
    return;
  }

  const created = await createPage(
    ENGINE_CONFIG.studiesDbId,
    {
      [ENGINE_CONFIG.studyNamePropName]: prop.title(study.name),
      [ENGINE_CONFIG.studyContractSignDatePropName]: prop.date(desiredCsd),
    },
    { token: opts.token },
  );
  ctx.productionStudyId = created.id;
  ctx.productionStudyExisted = false;
  ok(`Production Study created: ${created.id}`);
}

async function wireRoundTripRelation(study, ctx) {
  phase(3, `Wire Exported Studies ↔ Production Study (1:1 round-trip)`);

  if (ctx.productionStudyIsPlaceholder) {
    dryNote(`Production Study is a dry-run placeholder; live run will PATCH 1:1 round-trip.`);
    return;
  }

  // The Production Study ↔ Exported Study relation is dual_property
  // (verified live: Exported Studies.Production Study has dual_property syncing
  // to cascade Studies.Exported Study). Setting one side propagates to the
  // other automatically, so we only need to PATCH one side.
  const exportedRow = await getPage(ctx.exportedStudyRowId, { token: opts.token });
  const currentRel = readRelation(exportedRow, ENGINE_CONFIG.exportedStudyProductionStudyPropName);
  if (currentRel.length === 1 && currentRel[0] === ctx.productionStudyId) {
    ok('Production Study relation already set 1:1 on Exported Studies row');
  } else {
    info(`setting Exported Studies → Production Study relation → ${ctx.productionStudyId}`);
    if (opts.dryRun) {
      dryNote(`would PATCH ${ctx.exportedStudyRowId} Production Study relation → ${ctx.productionStudyId}`);
    } else {
      await patchPage(
        ctx.exportedStudyRowId,
        {
          properties: {
            [ENGINE_CONFIG.exportedStudyProductionStudyPropName]: prop.relation(ctx.productionStudyId),
          },
        },
        { token: opts.token },
      );
      ok('Production Study relation set');
    }
  }

  // Verify reverse side propagated (sanity, since dual_property auto-syncs).
  if (!opts.dryRun) {
    const prodPage = await getPage(ctx.productionStudyId, { token: opts.token });
    const reverseRel = readRelation(prodPage, ENGINE_CONFIG.studyExportedStudyPropName);
    if (reverseRel.length === 1 && reverseRel[0] === ctx.exportedStudyRowId) {
      ok('1:1 round-trip verified (Production Study → Exported Study)');
    } else {
      // Fallback: PATCH explicitly. Shouldn't be needed if relation is dual.
      warn(`reverse relation didn't propagate; PATCHing explicitly`);
      await patchPage(
        ctx.productionStudyId,
        {
          properties: {
            [ENGINE_CONFIG.studyExportedStudyPropName]: prop.relation(ctx.exportedStudyRowId),
          },
        },
        { token: opts.token },
      );
      ok('1:1 round-trip wired (manual)');
    }
  }
}

async function ensureInception(study, ctx) {
  phase(4, `Inception (Study Tasks creation)`);

  if (opts.skipInception) {
    info('--skip-inception set, skipping');
    return;
  }

  // Check existing Study Tasks count first — Inception is double-blocked
  // by the engine, so skipping is the safe response when tasks are present.
  if (!opts.dryRun) {
    const existingTasks = await queryDb(
      ENGINE_CONFIG.studyTasksDbId,
      {
        filter: {
          property: 'Study',
          relation: { contains: ctx.productionStudyId },
        },
      },
      { token: opts.token },
    );
    if (existingTasks.length >= ENGINE_CONFIG.inceptionMinStudyTasks) {
      ok(`Inception already done: ${existingTasks.length} Study Tasks exist`);
      return;
    }
    if (existingTasks.length > 0) {
      throw new Error(
        `Production Study has ${existingTasks.length} Study Tasks (< ${ENGINE_CONFIG.inceptionMinStudyTasks} threshold) — partial state. Investigate before proceeding.`,
      );
    }
  }

  info(`firing POST ${opts.engineUrl}/webhook/inception`);
  if (opts.dryRun) {
    dryNote(`would POST inception with { data: { id: ${ctx.productionStudyId} } }`);
    dryNote(`would poll Study Tasks DB until count >= ${ENGINE_CONFIG.inceptionMinStudyTasks} (5min timeout)`);
    return;
  }

  await fireInception(opts.engineUrl, opts.webhookSecret, ctx.productionStudyId);
  ok('Inception webhook accepted (200)');

  info(`polling Study Tasks count (every 10s, 5min timeout)…`);
  const finalCount = await pollStudyTasksCount({
    studyTasksDbId: ENGINE_CONFIG.studyTasksDbId,
    productionStudyId: ctx.productionStudyId,
    minCount: ENGINE_CONFIG.inceptionMinStudyTasks,
    token: opts.token,
    onTick: (n) => process.stdout.write(`    Study Tasks: ${n}\r`),
  });
  process.stdout.write('\n');
  ok(`Inception complete: ${finalCount} Study Tasks`);
}

async function consolidateMigratedTasks(study, ctx) {
  phase(5, `Consolidate per-study rows → Asana Exported Tasks`);

  // Resolve dest data_source_id from the database (move-page needs data_source_id, not database_id).
  const destDb = await retrieveDb(ENGINE_CONFIG.asanaExportedTasksDbId, { token: opts.token });
  const dataSources = destDb?.data_sources || [];
  if (dataSources.length === 0) {
    throw new Error(
      `Asana Exported Tasks DB ${ENGINE_CONFIG.asanaExportedTasksDbId} has no data_sources in /v1/databases response — cannot move pages.`,
    );
  }
  if (dataSources.length > 1) {
    warn(`Asana Exported Tasks has ${dataSources.length} data sources; using the first (${dataSources[0].name})`);
  }
  ctx.destDataSourceId = dataSources[0].id;
  info(`destination data_source_id: ${ctx.destDataSourceId}`);

  // Resolve source DB ID — Amgen NMOSD is intentionally null in config until verified.
  if (!study.perStudyMigratedDbId) {
    info(`per-study migrated DB ID not configured — searching Notion for "${study.name} migrated"`);
    if (opts.dryRun) {
      dryNote(`would search Notion for DB titled "${study.name} migrated" and confirm with user`);
      return;
    }
    const hits = await search(`${study.name} migrated`, { token: opts.token });
    const dbHits = (hits.results || []).filter((r) => r.object === 'database');
    if (dbHits.length === 0) {
      throw new Error(`No Notion database titled "${study.name} migrated" — verify name and rerun.`);
    }
    warn(`found ${dbHits.length} candidate DB(s):`);
    for (const h of dbHits) {
      const title = (h.title || []).map((t) => t.plain_text).join('') || '<untitled>';
      warn(`  ${h.id} — ${title}`);
    }
    throw new Error(`per-study migrated DB ID not configured for ${study.key}. Add it to config.js and rerun.`);
  }

  // Read all source rows.
  const sourceRows = await queryDb(study.perStudyMigratedDbId, {}, { token: opts.token });
  info(`source rows in per-study migrated DB: ${sourceRows.length}`);

  if (sourceRows.length === 0) {
    warn('source DB is empty — nothing to consolidate; continuing to Migrator anyway');
    ctx.consolidatedCount = 0;
    return;
  }

  // Identify which source rows are already in the dest (idempotency check).
  // Notion preserves page IDs across moves, so we ask: which of these source row ids
  // are *already* in the Asana Exported Tasks DB?
  const alreadyInDest = new Set();
  for (const row of sourceRows) {
    // Page parent reflects current location.
    const parent = row.parent;
    if (
      parent?.type === 'database_id' &&
      parent.database_id?.replace(/-/g, '') === ENGINE_CONFIG.asanaExportedTasksDbId.replace(/-/g, '')
    ) {
      alreadyInDest.add(row.id);
    }
  }

  // The query above filtered by source DB, so technically every row IS in source.
  // The set is empty by construction. We keep the check for clarity — when run as
  // a sanity net during retry sequences (where some rows might be in flight), it's
  // a no-op rather than a hazard.
  if (alreadyInDest.size > 0) info(`${alreadyInDest.size} rows already in Asana Exported Tasks (will skip)`);

  const toMove = sourceRows.filter((r) => !alreadyInDest.has(r.id));
  info(`rows to move: ${toMove.length}`);

  // Show first 5 row titles as a spot-check, then summarize.
  const sample = toMove.slice(0, 5).map((r) => readTitle(r) || readTitle(r, 'Title') || '<untitled>');
  for (const t of sample) info(`  • ${t}`);
  if (toMove.length > sample.length) info(`  … and ${toMove.length - sample.length} more`);

  if (opts.dryRun) {
    dryNote(`would MOVE ${toMove.length} pages → data_source_id ${ctx.destDataSourceId}`);
    dryNote(`would PATCH each moved page with Study relation → ${ctx.exportedStudyRowId}`);
    ctx.consolidatedCount = toMove.length;
    return;
  }

  // Bulk move.
  info(`moving ${toMove.length} pages…`);
  const { moved } = await movePages(
    toMove.map((r) => r.id),
    ctx.destDataSourceId,
    { token: opts.token },
  );
  ok(`moved ${moved.length} pages`);

  // Per-row post-move PATCH: set Study relation + any group-specific transforms.
  const transformer = study.transform();
  let patched = 0;
  for (const sourceRow of toMove) {
    const groupPatch = transformer.postMovePatch(sourceRow, ctx.exportedStudyRowId) || {};
    const patchProps = {
      ...groupPatch,
      [ENGINE_CONFIG.exportedTaskStudyPropName]: prop.relation(ctx.exportedStudyRowId),
    };
    await patchPage(sourceRow.id, { properties: patchProps }, { token: opts.token });
    patched++;
    if (patched % 10 === 0) process.stdout.write(`    PATCHed ${patched}/${toMove.length}\r`);
  }
  process.stdout.write('\n');
  ok(`PATCHed ${patched} rows with Study relation`);

  // Verification: re-query Asana Exported Tasks for rows linked to this study
  // and warn if the count diverges from what we just patched. Catches silent
  // pagination loss in queryDb (see PR #96 GSK SLE BEACON incident).
  const verify = await queryDb(
    ENGINE_CONFIG.asanaExportedTasksDbId,
    { filter: { property: ENGINE_CONFIG.exportedTaskStudyPropName, relation: { contains: ctx.exportedStudyRowId } } },
    { token: opts.token },
  );
  if (verify.length !== patched) {
    warn(`Phase 5 verification mismatch: PATCHed ${patched}, but ${verify.length} rows linked. Re-running Phase 5 may be needed.`);
  }

  ctx.consolidatedCount = toMove.length;
}

async function triggerMigrator(study, ctx) {
  phase(6, `Trigger Migrator + poll for completion`);

  if (opts.skipMigrator) {
    info('--skip-migrator set; stopping here');
    return;
  }

  info(`firing POST ${opts.engineUrl}/webhook/migrate-study`);
  if (opts.dryRun) {
    dryNote(`would POST migrate-study with { data: { id: ${ctx.exportedStudyRowId} } }`);
    dryNote(`would poll Production Study Automation Reporting (10min timeout)`);
    return;
  }

  const startedAt = new Date();
  await fireMigrateStudy(opts.engineUrl, opts.webhookSecret, ctx.exportedStudyRowId);
  ok('Migrate Study webhook accepted (200)');

  info(`polling Automation Reporting (every 15s, 10min timeout)…`);
  const final = await pollAutomationReporting({
    productionStudyId: ctx.productionStudyId,
    startedAfter: startedAt,
    token: opts.token,
    onTick: ({ text }) => process.stdout.write(`    last: ${(text || '').slice(0, 80)}\r`),
  });
  process.stdout.write('\n');
  ok(`Migrate Study terminal state: ${final.text}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function migrateStudy(study) {
  log(c.bold(`\n══════════════════════════════════════════════════════════════════════`));
  log(c.bold(`  Study: ${study.name}  (Group ${study.group}, key: ${study.key})`));
  log(c.bold(`══════════════════════════════════════════════════════════════════════`));
  if (opts.dryRun) log(c.yellow('  DRY RUN — no Notion writes, no engine webhook calls'));

  const ctx = { studyKey: study.key };
  try {
    await resolveExportedStudiesRow(study, ctx);
    await resolveOrCreateProductionStudy(study, ctx);
    await wireRoundTripRelation(study, ctx);
    await ensureInception(study, ctx);
    await consolidateMigratedTasks(study, ctx);
    await triggerMigrator(study, ctx);
    log(c.green(c.bold(`\n✓ ${study.name} done\n`)));
    return { study: study.key, status: 'ok', ctx };
  } catch (err) {
    log(c.red(c.bold(`\n✗ ${study.name} failed: ${err.message}\n`)));
    if (err.body) log(c.dim(err.body));
    return { study: study.key, status: 'error', error: err.message, ctx };
  }
}

(async function main() {
  const targets = opts.all
    ? STUDIES
    : [findStudyConfig(opts.study)].filter(Boolean);
  if (!targets.length) usage(`unknown study: ${opts.study}`);

  log(c.cyan(`Engine URL: ${opts.engineUrl}`));
  log(c.cyan(`Studies in this run: ${targets.map((s) => s.key).join(', ')}`));

  const results = [];
  for (const study of targets) {
    const result = await migrateStudy(study);
    results.push(result);
    if (result.status === 'error' && opts.all) {
      warn(`halting batch on ${study.key} failure (--all). Subsequent studies skipped.`);
      break;
    }
  }

  log(c.bold('\n──── Summary ────'));
  for (const r of results) {
    const icon = r.status === 'ok' ? c.green('✓') : c.red('✗');
    log(`  ${icon} ${r.study}${r.error ? ` — ${r.error}` : ''}`);
  }
  process.exit(results.some((r) => r.status === 'error') ? 1 : 0);
})();
