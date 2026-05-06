/**
 * Group B transform — Pfizer Heme A 001.
 *
 * Source `Task Type Tags` is rich_text; destination is multi_select. The move
 * auto-mapper can't bridge those types, so post-move we read the original
 * source rich_text, tokenize it, and PATCH the canonical destination
 * multi_select. `prop.multi_select` sends by name — Notion matches existing
 * options or auto-creates new ones, so no option-id resolution is needed.
 *
 * preMoveRead is unused (the orchestrator never invokes it; sourcePage is
 * the full pre-move page object passed straight to postMovePatch).
 */

import { readRichText, prop } from '../notion.js';

const TAG_DELIMITERS = /[,;|\n\r]+/;

export function pfizerHemeATransform() {
  return {
    preMoveRead(_sourcePage) {
      return {};
    },
    postMovePatch(sourcePage, _exportedStudyRowId) {
      const raw = readRichText(sourcePage, 'Task Type Tags');
      if (!raw) return {};
      const tokens = raw
        .split(TAG_DELIMITERS)
        .map((t) => t.trim())
        .filter(Boolean);
      if (tokens.length === 0) return {};
      return { 'Task Type Tags': prop.multi_select(tokens) };
    },
  };
}
