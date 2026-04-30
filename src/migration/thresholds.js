/**
 * Thresholds for migrate-study webhook.
 *
 * Only structural / matcher-tuning knobs survive — quality-blocking thresholds
 * (min/max migrated count, unmatched ratio, low-tier cap) were removed because
 * the actual workflow is "match what we can, PMs reconcile the rest in the
 * Migration Support callout." Gates that block valid runs on data-quality
 * grounds were causing more pain than they prevented.
 *
 * Override via environment variables (see {@link parseMigrationThresholdsFromEnv}).
 */
export const DEFAULT_MIGRATION_THRESHOLDS = {
  /** Minimum Study Tasks linked to the study (Inception prerequisite — structural, not data-quality). */
  minStudyTasks: 100,
  /**
   * Minimum Jaccard token-set similarity for low-tier match (0–1).
   * Matcher tuning, not a gate. Lowered from 0.6 → 0.45 once quality-threshold
   * gates were removed: with PMs reconciling false positives via the Migration
   * Support callout, "match what we can" benefits from a more lenient floor.
   * Studies whose data needs a stricter floor can override via env.
   */
  jaccardMin: 0.45,
};

export function parseMigrationThresholdsFromEnv() {
  return {
    minStudyTasks: parseInt(process.env.MIGRATE_MIN_STUDY_TASKS || String(DEFAULT_MIGRATION_THRESHOLDS.minStudyTasks), 10),
    jaccardMin: parseFloat(process.env.MIGRATE_JACCARD_MIN || String(DEFAULT_MIGRATION_THRESHOLDS.jaccardMin)),
  };
}
