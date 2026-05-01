/**
 * Group A transform — direct carryover, no schema mismatch.
 *
 * Source per-study migrated DB columns match destination Asana Exported Tasks
 * by name + type, so Notion's move-page handles all property carryover.
 *
 * preMoveRead: returns nothing structural — orchestrator only needs source
 *   page IDs for the move. Function exists for symmetry with B/C transforms.
 *
 * postMovePatch: returns an empty property bag. Orchestrator always merges
 *   `Study` relation into the patch — Group A relies on that as the only
 *   post-move write per row.
 */

export function groupATransform() {
  return {
    preMoveRead(_sourcePage) {
      return {};
    },
    postMovePatch(_sourcePage, _exportedStudyRowId) {
      return {}; // orchestrator adds { Study: relation(exportedStudyRowId) }
    },
  };
}
