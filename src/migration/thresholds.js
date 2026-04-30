/**
 * Abort thresholds for migrate-study webhook (dry-run gate before any writes).
 * Override via environment variables (see {@link parseMigrationThresholdsFromEnv}).
 */
export const DEFAULT_MIGRATION_THRESHOLDS = {
  /** Minimum Study Tasks linked to the study (inception sanity). */
  minStudyTasks: 100,
  /** Minimum Migrated Tasks rows for this study (carryover sanity). */
  minMigratedTasks: 10,
  /** Maximum Migrated Tasks rows (wrong filter guardrail). */
  maxMigratedTasks: 500,
  /**
   * Abort if (unmatched completed rows / completed rows) exceeds this ratio.
   * Completed rows exclude Repeat Delivery milestone (per migrate-study §4a).
   */
  maxUnmatchedCompletedRatio: 0.25,
  /** Abort if low-confidence (Jaccard) matches exceed this count (safety). */
  maxLowTierMatches: 50,
  /** Minimum Jaccard token-set similarity for low-tier match (0–1). */
  jaccardMin: 0.6,
};

export function parseMigrationThresholdsFromEnv() {
  return {
    minStudyTasks: parseInt(process.env.MIGRATE_MIN_STUDY_TASKS || String(DEFAULT_MIGRATION_THRESHOLDS.minStudyTasks), 10),
    minMigratedTasks: parseInt(process.env.MIGRATE_MIN_MIGRATED_TASKS || String(DEFAULT_MIGRATION_THRESHOLDS.minMigratedTasks), 10),
    maxMigratedTasks: parseInt(process.env.MIGRATE_MAX_MIGRATED_TASKS || String(DEFAULT_MIGRATION_THRESHOLDS.maxMigratedTasks), 10),
    maxUnmatchedCompletedRatio: parseFloat(
      process.env.MIGRATE_MAX_UNMATCHED_COMPLETED_RATIO || String(DEFAULT_MIGRATION_THRESHOLDS.maxUnmatchedCompletedRatio),
    ),
    maxLowTierMatches: parseInt(process.env.MIGRATE_MAX_LOW_TIER_MATCHES || String(DEFAULT_MIGRATION_THRESHOLDS.maxLowTierMatches), 10),
    jaccardMin: parseFloat(process.env.MIGRATE_JACCARD_MIN || String(DEFAULT_MIGRATION_THRESHOLDS.jaccardMin)),
  };
}
