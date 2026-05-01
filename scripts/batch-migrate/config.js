/**
 * Per-study config for the batch-migrate orchestrator.
 *
 * Studies are keyed by stable Notion DB IDs, NOT by study name (avoids
 * Pfizer Heme 002 vs Pfizer Heme A 001 confusion — they're different studies).
 *
 * Every entry needs:
 *   - key: CLI-friendly slug (used by --study)
 *   - name: human-facing study name (used in titles + logs)
 *   - group: 'A' | 'B' | 'C' — schema-mismatch tier
 *   - perStudyMigratedDbId: source DB to consolidate from
 *   - contractSignDate: 'YYYY-MM-DD' — needed by Inception (set on Production Study before /webhook/inception)
 *   - transform: factory function that returns { preMoveRead(sourcePage), postMovePatch(sourcePage, exportedStudyRowId) }
 *
 * preMoveRead is a chance to read fields off the source row before the move
 * (since Notion's move-page might rename mismatched columns or schema-extend the dest).
 * postMovePatch returns the property update for the moved page; orchestrator
 * always merges in `Study` relation -> exportedStudyRowId, so Group A's
 * postMovePatch is a no-op.
 */

import { groupATransform } from './transforms/group-a.js';

export const STUDIES = [
  {
    key: 'moderna-mma-pa-compass',
    name: 'Moderna MMA PA COMPASS',
    group: 'A',
    perStudyMigratedDbId: '34d23867-60c2-8199-bfb2-da403739bc8a',
    // Tem fills this in before live run. Inception aborts if Contract Sign Date is empty.
    contractSignDate: null,
    transform: groupATransform,
  },
  {
    key: 'argenx-cidp-001',
    name: 'argenx CIDP 001',
    group: 'A',
    perStudyMigratedDbId: '34d23867-60c2-8165-a5ea-ca7c49acf132',
    contractSignDate: null,
    transform: groupATransform,
  },
  // Group A — slot for Amgen, DB ID resolved at runtime via search:
  {
    key: 'amgen-nmosd-observe-nmo',
    name: 'Amgen NMOSD OBSERVE-NMO',
    group: 'A', // assumed; script verifies at runtime
    perStudyMigratedDbId: null, // resolved at runtime via Notion search
    contractSignDate: null,
    transform: groupATransform,
  },
  // Group B — Sanofi (Task Type Tags missing on source):
  {
    key: 'sanofi-pre-t1d-tepli-quest',
    name: 'Sanofi Pre-T1D Tepli-QUEST',
    group: 'B',
    perStudyMigratedDbId: '34d23867-60c2-819e-8775-fdf79ea83f5a',
    contractSignDate: null,
    // Group B/C transforms come in follow-up commits — Group A is enough for tonight's Moderna run.
    transform: groupATransform,
  },
  // Group C — Ionis HAE 001 (mini-Gantt schema):
  {
    key: 'ionis-hae-001',
    name: 'Ionis HAE 001',
    group: 'C',
    perStudyMigratedDbId: '34d23867-60c2-8142-b0fc-e41bb671d84d',
    contractSignDate: null,
    transform: groupATransform, // PLACEHOLDER — replace with ionis-hae-001 transform before run
  },
  // Group C — Pfizer Heme 002 (mini-Gantt schema, NOT Pfizer Heme A 001):
  {
    key: 'pfizer-heme-002',
    name: 'Pfizer Heme 002',
    group: 'C',
    perStudyMigratedDbId: '34d23867-60c2-8169-8e69-dfd9f8c178e7',
    contractSignDate: null,
    transform: groupATransform, // PLACEHOLDER
  },
  // Group C — Ipsen PBC 001 (bare-bones schema):
  {
    key: 'ipsen-pbc-001',
    name: 'Ipsen PBC 001',
    group: 'C',
    perStudyMigratedDbId: '34d23867-60c2-81fa-b227-d899e465e1c6',
    contractSignDate: null,
    transform: groupATransform, // PLACEHOLDER
  },
];

/** Engine + cascade DB IDs. Mirrors src/migration/constants.js + .env.example. */
export const ENGINE_CONFIG = {
  // Cascade (production) DBs:
  studiesDbId: process.env.STUDIES_DB_ID || 'cad2386760c2836fa27d0131c25b6dcd',
  studyTasksDbId: process.env.STUDY_TASKS_DB_ID || '40f2386760c2830eaad68159ca69a8d6',

  // Migration consolidated DBs (engine reads these):
  // Note: engine code calls these "Migrated Tasks" / "Migrated Studies"; in the
  // Notion UI they're titled "Asana Exported Tasks" / "Exported Studies".
  asanaExportedTasksDbId: process.env.MIGRATED_TASKS_DB_ID || 'aaa4397d-cd59-4441-a91c-e01885f9b59f',
  exportedStudiesDbId: process.env.MIGRATED_STUDIES_DB_ID || 'a75fd9ee-f39e-442c-b55c-3d1175fba7cb',

  // Property names on Asana Exported Tasks (matches MIGRATED_TASK_PROP in src/migration/constants.js):
  exportedTaskStudyPropName: 'Study',

  // Property names on Exported Studies (matches MIGRATED_STUDIES_PROP + verified live 2026-04-30):
  exportedStudyTitlePropName: 'Study Name',
  exportedStudyContractStartDatePropName: 'Contract Start Date',
  exportedStudyProductionStudyPropName: 'Production Study',

  // Property names on cascade Studies (matches STUDIES_PROPS in src/notion/property-names.js):
  // We use NAME-keyed access in the script; the engine's id-keyed access is
  // rename-immune at runtime. The script tolerates this since it's a one-off.
  // Cascade Studies DB title is "Study Name (Internal)" (per STUDIES_PROPS.STUDY_NAME).
  studyNamePropName: 'Study Name (Internal)',
  studyContractSignDatePropName: 'Contract Sign Date',
  studyExportedStudyPropName: 'Exported Study',
  studyAutomationReportingPropName: 'Automation Reporting',

  // Inception success threshold:
  inceptionMinStudyTasks: Number(process.env.MIGRATE_MIN_STUDY_TASKS) || 100,

  // Engine deployed URL:
  engineUrl: process.env.ENGINE_URL || 'https://picnic-cascade-engine-production.up.railway.app',
};

export function findStudyConfig(key) {
  return STUDIES.find((s) => s.key === key);
}
