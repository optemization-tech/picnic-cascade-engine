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
 * Detach the leading recognized emoji marker (if any) and strip the study-name
 * prefix into separate output fields. The emoji is what migrate-study writes as
 * the page icon; the title is what gets written as the page Name.
 *
 *   "🔶  Alexion PNH PLEDGE Final SAP Delivery" → { title: "Final SAP Delivery", emoji: "🔶" }
 *   "Alexion PNH: Submit IRB"                  → { title: "Submit IRB",         emoji: null }
 *   "🔶 Random Task"                           → { title: "Random Task",        emoji: "🔶" }
 *   "Final SAP Delivery"                       → { title: "Final SAP Delivery", emoji: null }
 *   "🔶 Alexion PNH PLEDGE"  (would empty)     → { title: "🔶 Alexion PNH PLEDGE", emoji: null }
 *   missing studyName                          → { title: <input>,              emoji: null }
 *   non-recognized leading emoji ('📌 …')      → { title: <input>,              emoji: null }
 *
 * Reduce-to-empty case returns the input wholesale and `emoji: null` so call
 * sites skip both the title PATCH and the icon PATCH (idempotent on the
 * pathological row that's just the study name and a marker).
 */
export function splitStudyPrefixAndEmoji(name, studyName) {
  if (!name || typeof name !== 'string') return { title: name || '', emoji: null };
  if (!studyName || typeof studyName !== 'string') return { title: name, emoji: null };
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
  if (!stripped) {
    // Pathological row (title was nothing but the study name + optional marker).
    // Preserve the original and emit emoji=null so neither PATCH fires.
    return { title: name, emoji: null };
  }
  return { title: stripped, emoji };
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
