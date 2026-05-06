/**
 * Group B transform — Calliditas IgAN PERFORM.
 *
 * Source `Start Date` is rich_text; destination is date. After move, the
 * canonical destination Start Date stays empty (Notion adds a sibling
 * rich_text column instead). We parse the source string and PATCH the date.
 *
 * Parser handles: ISO 8601 lead (YYYY-MM-DD…), MM/DD/YYYY, and JS Date.parse
 * fallback ("Mon DD, YYYY" etc.). Unparseable values warn to stderr and
 * leave Start Date empty rather than failing the row.
 */

import { readRichText, prop } from '../notion.js';

function parseDateString(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const isoLead = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoLead) return isoLead[1];

  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return new Date(t).toISOString().split('T')[0];

  return null;
}

export function calliditasStartDateTransform() {
  return {
    preMoveRead(_sourcePage) {
      return {};
    },
    postMovePatch(sourcePage, _exportedStudyRowId) {
      const raw = readRichText(sourcePage, 'Start Date');
      if (!raw) return {};
      const iso = parseDateString(raw);
      if (!iso) {
        console.warn(
          `[calliditasStartDateTransform] unparseable Start Date "${raw}" on ${sourcePage.id} — leaving empty`,
        );
        return {};
      }
      return { 'Start Date': prop.date(iso) };
    },
  };
}
