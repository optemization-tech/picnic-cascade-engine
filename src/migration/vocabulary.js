/**
 * §11 vocabulary map: Migrated Tasks Milestone (single select) → canonical Blueprint Milestone label.
 * Source: engagements/picnic-health/projects/migration/prompts/00-shared-csv-and-matching.md
 */
export const MILESTONE_VOCAB = Object.freeze({
  'Contract Signed': 'Contract Signed',
  'External Kickoff Meeting': 'External Kickoff',
  'Submit IRB': 'IRB Submission',
  'IRB Review & Approval': 'IRB Approval',
  'Launch Enrollment': 'Launch Enrollment',
  'FPI First Patient In': 'First Patient In (FPI)',
  'First Site(s) Activated': 'First Site Activated',
  'SAP Delivery': 'SAP Delivery',
  'Abstraction Launch': 'Initial Abstraction Complete',
  'Additional Site(s) Activated': 'Additional Site(s) Activated',
  'Initial Data Delivery': 'Initial Data Delivery',
  'TLF Delivery': 'TLF Delivery',
  'Insight Report Delivery': 'Insights Delivery',
  'CSR Delivery': 'CSR Delivery',
  'Last Site(s) Activated': 'Last Site Activated',
  'Repeat Delivery': 'Repeat Data Delivery',
  'LPI Last Patient In': 'Last Patient In (LPI)',
  'Last Patient Out': 'Last Patient Out',
  'Final Data Delivery': 'Final Data Delivery',
  'Study Closure (Contract End Date)': 'Study Closure (Contract End Date)',
  'Invoicing Milestone': null,
});

/** Normalize milestone map keys — Notion returns select name as stored. */
export function mapSourceMilestone(sourceSelectName) {
  if (!sourceSelectName) return null;
  const direct = MILESTONE_VOCAB[sourceSelectName];
  if (direct !== undefined) return direct;
  return null;
}
