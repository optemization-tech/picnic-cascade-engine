/**
 * Read helpers for Notion page properties (name-keyed API responses).
 */

export function titlePlain(properties, titlePropName = 'Name') {
  const p = properties?.[titlePropName];
  if (!p?.title?.length) return '';
  return p.title.map((t) => t.plain_text || '').join('');
}

export function richTextPlain(properties, propName) {
  const p = properties?.[propName];
  if (!p?.rich_text?.length) return '';
  return p.rich_text.map((t) => t.plain_text || '').join('');
}

export function checkbox(properties, propName) {
  const p = properties?.[propName];
  return Boolean(p?.checkbox);
}

export function dateStart(properties, propName) {
  const p = properties?.[propName];
  const d = p?.date;
  if (!d) return null;
  return d.start || null;
}

export function multiSelectNames(properties, propName) {
  const p = properties?.[propName];
  if (!p?.multi_select?.length) return [];
  return p.multi_select.map((o) => o.name).filter(Boolean);
}

export function selectName(properties, propName) {
  const p = properties?.[propName];
  return p?.select?.name || null;
}

export function relationIds(properties, propName) {
  const p = properties?.[propName];
  if (!p?.relation?.length) return [];
  return p.relation.map((r) => r.id).filter(Boolean);
}
