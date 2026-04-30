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
   * Matcher tuning, not a gate. Lowered from the original 0.6 over two passes:
   *   0.6 → 0.45 once quality gates were removed (PR #88) so PMs began
   *   reconciling false positives via the Migration Support callout.
   *   0.45 → 0.35 once name aliases (MILESTONE_VOCAB) flowed through Jaccard
   *   tokenization (PR #92) so common phrasings ("External Kickoff Meeting"
   *   ↔ "External Kickoff") already snap to the same canonical tokens; the
   *   remaining floor is purely a precision/recall trade-off, and the user's
   *   product principle is "match what we can, PMs reconcile the rest."
   * Studies whose data needs a stricter floor can override via env.
   */
  jaccardMin: 0.35,
};

export function parseMigrationThresholdsFromEnv() {
  return {
    minStudyTasks: parseInt(process.env.MIGRATE_MIN_STUDY_TASKS || String(DEFAULT_MIGRATION_THRESHOLDS.minStudyTasks), 10),
    jaccardMin: parseFloat(process.env.MIGRATE_JACCARD_MIN || String(DEFAULT_MIGRATION_THRESHOLDS.jaccardMin)),
  };
}
