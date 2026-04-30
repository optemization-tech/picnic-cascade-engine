import { MILESTONE_VOCAB } from './vocabulary.js';

/** Companion §2 — trim, collapse space, lowercase, strip leading emoji/markers. Parentheses preserved. */

/** Strip leading milestone markers from §2 (defensive). */
function stripLeadingMarkers(s) {
  let t = s.trim();
  const prefixes = ['🔶', '✅', '🔷', '⚠️', '🚨'];
  for (const pre of prefixes) {
    if (t.startsWith(pre)) t = t.slice(pre.length).trimStart();
  }
  return t;
}

/**
 * Strip the study name from the leading position of a task title.
 *
 * Source data often wraps cascade-equivalent task names with the study identifier
 * — e.g., `🔶 Alexion PNH PLEDGE External Kickoff`, `Alexion PNH: Submit IRB`.
 * The leading study name suppresses the matcher's normalized-name and Jaccard
 * tiers because tokens like "alexion" / "pnh" / "pledge" survive normalization
 * and inflate the union without contributing to intersection.
 *
 * Implementation: tokenize the study name into a set, then iteratively eat the
 * leading word from the title whenever it (case-insensitively) belongs to that
 * set. Separators (`:`, `,`, `;`, `.`, `-`, whitespace) between matches are
 * skipped. Stops the moment a non-study word appears, so internal occurrences
 * of study tokens (e.g., a task body that legitimately mentions PNH) are
 * preserved.
 */
/** Title emoji markers we recognise as semantic prefixes (kept on rename). */
const TITLE_EMOJI_PREFIXES = ['🔶', '✅', '🔷', '⚠️', '🚨'];

/**
 * Produce a clean Migrated-Task title by stripping the study-name prefix while
 * preserving a leading emoji marker (the 🔶 etc. carry semantic intent — milestone-
 * type rows in Asana — even though they aren't load-bearing for matching).
 *
 *   "🔶  Alexion PNH PLEDGE Final SAP Delivery" → "🔶 Final SAP Delivery"
 *   "Alexion PNH: Submit IRB"                  → "Submit IRB"
 *   "Final SAP Delivery"                       → "Final SAP Delivery" (unchanged)
 *   "Alexion PNH PLEDGE" alone                 → "Alexion PNH PLEDGE" (don't reduce to empty)
 */
export function cleanTitleByStrippingStudyPrefix(name, studyName) {
  if (!name || typeof name !== 'string') return name || '';
  if (!studyName || typeof studyName !== 'string') return name;
  let emoji = null;
  let body = name;
  for (const pre of TITLE_EMOJI_PREFIXES) {
    if (body.startsWith(pre)) {
      emoji = pre;
      body = body.slice(pre.length);
      break;
    }
  }
  body = body.trimStart();
  const stripped = stripStudyPrefix(body, studyName);
  if (!stripped) return name;
  return emoji ? `${emoji} ${stripped}` : stripped;
}

export function stripStudyPrefix(name, studyName) {
  if (!name || typeof name !== 'string') return name || '';
  if (!studyName || typeof studyName !== 'string') return name;
  const studyTokens = studyName.toLowerCase().split(/\s+/).filter(Boolean);
  if (studyTokens.length === 0) return name;
  const tokenSet = new Set(studyTokens);
  let s = stripLeadingMarkers(name).trimStart();
  let progress = true;
  while (progress) {
    progress = false;
    s = s.replace(/^[\s:,.;\-]+/, '');
    if (!s) break;
    const head = s.match(/^([A-Za-z0-9]+)/);
    if (!head) break;
    if (tokenSet.has(head[1].toLowerCase())) {
      s = s.slice(head[0].length);
      progress = true;
    }
  }
  return s.trim();
}

const MARKERS = /^\[(?:FYI|Milestone|Optional|Parent|Subtask)\]\s*/i;

/**
 * Reusable, MILESTONE_VOCAB-derived name aliases. The vocabulary already maps
 * source-side milestone phrasings to canonical cascade milestone phrasings
 * (e.g., "External Kickoff Meeting" → "External Kickoff", "Submit IRB" →
 * "IRB Submission"). Applied as case-insensitive word-boundary substitutions
 * during name normalization and Jaccard tokenization, so both the name-lookup
 * tier and the low-tier Jaccard score benefit.
 */
const NAME_ALIAS_PATTERNS = (() => {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entries = [];
  for (const [source, canonical] of Object.entries(MILESTONE_VOCAB)) {
    if (!canonical) continue;
    if (source === canonical) continue; // identity mapping is a no-op
    entries.push({
      pattern: new RegExp(`\\b${escapeRe(source)}\\b`, 'gi'),
      canonical,
    });
  }
  // Longest-source-first, so "External Kickoff Meeting" replaces before the
  // shorter "External Kickoff" key (if present) tries.
  return entries.sort((a, b) => b.pattern.source.length - a.pattern.source.length);
})();

export function applyNameAliases(name) {
  if (!name || typeof name !== 'string') return name || '';
  let result = name;
  for (const { pattern, canonical } of NAME_ALIAS_PATTERNS) {
    result = result.replace(pattern, canonical);
  }
  return result;
}

export function normalizeName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = stripLeadingMarkers(raw);
  s = applyNameAliases(s);
  s = s.trim().replace(/\s+/g, ' ').toLowerCase();
  for (;;) {
    const next = s.replace(MARKERS, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

export function stripParenSegment(name) {
  const n = normalizeName(name);
  return n.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeAssigneeForOwner(raw) {
  let s = normalizeName(raw);
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\b[a-z]\.\s*/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function tokenSet(str) {
  if (!str) return new Set();
  // Aliases applied so source/cascade phrasings meet at the canonical token
  // shape (e.g., "Submit IRB" tokens align with "IRB Submission" tokens).
  return new Set(
    applyNameAliases(str)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(Boolean),
  );
}

/** Token-set Jaccard similarity in [0,1]. */
export function jaccardTokens(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) {
    if (B.has(t)) inter += 1;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}
