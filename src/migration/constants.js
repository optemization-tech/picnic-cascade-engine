/**
 * PicnicHealth migration inputs — database IDs from docs/notion/DATABASE-SCHEMA.md
 * and prompts/00-shared-csv-and-matching.md §9.
 */
export const MIGRATED_TASKS_DB_ID = process.env.MIGRATED_TASKS_DB_ID || 'aaa4397d-cd59-4441-a91c-e01885f9b59f';

export const MIGRATED_STUDIES_DB_ID = process.env.MIGRATED_STUDIES_DB_ID || 'a75fd9ee-f39e-442c-b55c-3d1175fba7cb';

/** Name-keyed writes for Migrated Tasks DB (schema not in property-names.js). */
export const MIGRATED_TASK_PROP = {
  NAME: 'Name',
  STUDY: 'Study',
  TASK_TYPE_TAGS: 'Task Type Tags',
  MILESTONE: 'Milestone',
  COMPLETED: 'Completed',
  START_DATE: 'Start Date',
  DUE_DATE: 'Due Date',
  DATE_COMPLETED: 'Date Completed',
  WORKSTREAM: 'Workstream',
  ASSIGNEE: 'Assignee',
  PRODUCTION_TASK: 'Production Task',
  /** Live Picnic schema: relation to Study Tasks (replaces older "Production Task" label). */
  NOTION_TASK: 'Notion Task',
  /** Select property; options: High | Medium | Low. The cascade-side `Match Confidence` is a rollup of this via `Notion Task` <-> `Asana Task`. */
  MATCH_CONFIDENCE: 'Match Confidence',
};

/** Match Confidence select option labels — match the live Notion schema exactly. */
export const MATCH_CONFIDENCE_LABEL = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/**
 * Map matcher tier → Match Confidence select label.
 * `prefilled` rows had Production Task already linked (definitionally certain),
 * so they map to High alongside the matcher's `high` tier.
 */
export function tierToMatchConfidence(tier) {
  switch (tier) {
    case 'prefilled':
    case 'high':
      return MATCH_CONFIDENCE_LABEL.HIGH;
    case 'medium':
      return MATCH_CONFIDENCE_LABEL.MEDIUM;
    case 'low':
      return MATCH_CONFIDENCE_LABEL.LOW;
    default:
      return null;
  }
}

/** Order matters: legacy name first, then current Picnic label. */
export const MIGRATED_TASK_PRODUCTION_RELATION_NAMES = [
  MIGRATED_TASK_PROP.PRODUCTION_TASK,
  MIGRATED_TASK_PROP.NOTION_TASK,
];

/** Migrated Studies DB property names (name-keyed). */
export const MIGRATED_STUDIES_PROP = {
  PRODUCTION_STUDY: 'Production Study',
  MIGRATED_TASKS: 'Migrated Tasks',
};
