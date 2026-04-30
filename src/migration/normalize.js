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

export function normalizeName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = stripLeadingMarkers(raw);
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
  return new Set(
    str
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
