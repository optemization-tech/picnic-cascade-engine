/**
 * Startup safety net: clears stuck Import Mode from studies left ON by prior
 * crashes, OOM kills, or SIGKILL events. Import Mode is toggled ON at the start
 * of inception and OFF at the end — if the process dies mid-inception, it stays
 * ON indefinitely, blocking date-cascade for that study.
 *
 * This sweep runs once after app.listen() resolves. It is non-blocking (the
 * server accepts webhooks immediately) and never crashes the process — every
 * error is caught and logged.
 */

import { STUDIES_PROPS } from '../notion/property-names.js';

/**
 * Query for studies with Import Mode stuck ON and disable it.
 * @param {import('../notion/client.js').NotionClient} notionClient
 * @param {string} studiesDbId
 * @returns {Promise<{ studiesFound: number, studiesReset: number }>}
 */
export async function sweepStuckImportMode(notionClient, studiesDbId) {
  try {
    const stuckStudies = await notionClient.queryDatabase(
      studiesDbId,
      { property: STUDIES_PROPS.IMPORT_MODE.id, checkbox: { equals: true } },
    );

    let resetCount = 0;
    for (const study of stuckStudies) {
      try {
        await notionClient.patchPage(study.id, {
          [STUDIES_PROPS.IMPORT_MODE.id]: { checkbox: false },
        });
        resetCount++;
        console.warn(`[import-mode-sweep] Reset stuck Import Mode for study ${study.id}`);
      } catch (err) {
        // Log and continue — don't let one failed PATCH stop the remaining resets
        console.error(`[import-mode-sweep] Failed to reset study ${study.id}:`, err.message);
      }
    }

    console.log(JSON.stringify({ event: 'import_mode_sweep', studiesFound: stuckStudies.length, studiesReset: resetCount }));
    return { studiesFound: stuckStudies.length, studiesReset: resetCount };
  } catch (err) {
    console.error(JSON.stringify({ event: 'import_mode_sweep_error', error: err.message }));
    return { studiesFound: 0, studiesReset: 0 };
  }
}
