/**
 * Polling helpers for async pipeline phases.
 *
 * Inception writes Study Tasks rows. We watch the Study Tasks DB count
 * for the given study reach the inception minimum. Migrate Study writes
 * to Automation Reporting on the Production Study; we read that property
 * for the terminal status string.
 */

import { queryDb, getPage } from './notion.js';

/**
 * Poll the cascade Study Tasks DB until at least `minCount` rows exist
 * with `Study` relation pointing at `productionStudyId`. Times out.
 *
 * @returns {Promise<number>} the count when the threshold was reached
 */
export async function pollStudyTasksCount({
  studyTasksDbId,
  studyTasksStudyPropName = 'Study',
  productionStudyId,
  minCount = 100,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 10_000,
  token,
  onTick,
}) {
  const start = Date.now();
  while (true) {
    const rows = await queryDb(
      studyTasksDbId,
      {
        filter: {
          property: studyTasksStudyPropName,
          relation: { contains: productionStudyId },
        },
      },
      { token },
    );
    const count = rows.length;
    if (onTick) onTick(count);
    if (count >= minCount) return count;
    if (Date.now() - start > timeoutMs) {
      const err = new Error(
        `Inception polling timed out after ${Math.round(timeoutMs / 1000)}s — ${count}/${minCount} Study Tasks created`,
      );
      err.code = 'inception_timeout';
      err.partialCount = count;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Poll the Production Study's Automation Reporting property for a terminal
 * status. Migrate Study writes a final 'success' or 'error' message —
 * we look for either to short-circuit.
 *
 * Returns the final reported status (string) and the rich-text content.
 */
export async function pollAutomationReporting({
  productionStudyId,
  reportingPropName = 'Automation Reporting',
  startedAfter, // Date — ignore reports written before this point
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 15_000,
  token,
  onTick,
}) {
  const start = Date.now();
  while (true) {
    const page = await getPage(productionStudyId, { token });
    const reportProp = page?.properties?.[reportingPropName];
    const lastEditedTime = page?.last_edited_time ? new Date(page.last_edited_time) : null;

    // Try to extract reporting state. Engine writes status into rich_text or
    // a select-style status — we read whatever's there.
    let text = '';
    if (reportProp?.rich_text) text = reportProp.rich_text.map((t) => t.plain_text || '').join('');
    else if (reportProp?.formula?.string) text = reportProp.formula.string;
    else if (reportProp?.select?.name) text = reportProp.select.name;

    const isFresh = !startedAfter || (lastEditedTime && lastEditedTime > startedAfter);
    const lower = text.toLowerCase();
    const looksDone = isFresh && (
      lower.includes('migrate study') &&
      (lower.includes('success') || lower.includes('error') || lower.includes('failed') || lower.includes('complete'))
    );

    if (onTick) onTick({ text, lastEditedTime });
    if (looksDone) return { text, lastEditedTime };

    if (Date.now() - start > timeoutMs) {
      const err = new Error(
        `Migrate Study polling timed out after ${Math.round(timeoutMs / 1000)}s — last reporting: "${text.slice(0, 200)}"`,
      );
      err.code = 'migrate_timeout';
      err.lastReporting = text;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
