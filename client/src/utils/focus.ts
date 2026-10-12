/**
 * Focus (R05.2): the filter of a library list lives in the URL, so a filter
 * is shareable, survives a reload and comes back with the back button.
 *
 * The URL speaks the server's language (server/src/services/focus.ts):
 * repeated keys are OR within a facet, different keys are AND. Only the keys
 * below belong to Focus; anything else on the URL is left alone.
 */

export const FOCUS_LIST_KEYS = [
  'genre',
  'format',
  'source',
  'label',
  'composer',
  'tag',
  'rule',
] as const;
export const FOCUS_SCALAR_KEYS = [
  'sort',
  'order',
  'yearFrom',
  'yearTo',
  'quality',
  'favorite',
  'unplayed',
  'playedWithin',
  'addedWithin',
  'dedupeEditions',
] as const;
export type FocusListKey = (typeof FOCUS_LIST_KEYS)[number];
export type FocusScalarKey = (typeof FOCUS_SCALAR_KEYS)[number];
export type FocusKey = FocusListKey | FocusScalarKey;

export type SortKey = 'title' | 'artist' | 'year' | 'added' | 'lastPlayed' | 'plays' | 'duration';

export const SORT_LABELS: Record<SortKey, string> = {
  title: 'Title',
  artist: 'Artist',
  year: 'Year',
  added: 'Date added',
  lastPlayed: 'Last played',
  plays: 'Most played',
  duration: 'Duration',
};

/** "Recently" for the played/added toggles, in days. */
export const RECENT_DAYS = 30;

const ALL_KEYS: readonly string[] = [...FOCUS_LIST_KEYS, ...FOCUS_SCALAR_KEYS];

/**
 * The Focus part of the URL as a stable query string: keys and values in a
 * fixed order, so the same filter is always the same string (a cache key,
 * a React key, a bookmark).
 */
export function focusQueryString(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const key of [...FOCUS_SCALAR_KEYS, ...FOCUS_LIST_KEYS]) {
    const values = params.getAll(key).filter(Boolean);
    const unique = [...new Set(values)];
    if (FOCUS_LIST_KEYS.includes(key as FocusListKey)) unique.sort();
    else unique.splice(1);
    unique.forEach((v) => out.append(key, v));
  }
  return out.toString();
}

/** The query without sorting: what "is a filter on?" asks. */
export function filterCount(params: URLSearchParams): number {
  let n = 0;
  for (const key of ALL_KEYS) {
    if (key === 'sort' || key === 'order') continue;
    if (key === 'yearTo' && params.has('yearFrom')) continue; // one decade = one filter
    n += FOCUS_LIST_KEYS.includes(key as FocusListKey)
      ? params.getAll(key).length
      : params.has(key)
        ? 1
        : 0;
  }
  return n;
}

/** Toggle one value of a list facet (OR within the facet). */
export function toggleValue(
  params: URLSearchParams,
  key: FocusListKey,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const values = next.getAll(key);
  next.delete(key);
  const kept = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  kept.forEach((v) => next.append(key, v));
  return next;
}

/** Set or clear a single-valued key. */
export function setValue(
  params: URLSearchParams,
  key: FocusScalarKey,
  value: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === undefined || value === '') next.delete(key);
  else next.set(key, value);
  return next;
}

/** A decade is a year range; ticking the same decade again clears it. */
export function toggleDecade(params: URLSearchParams, decade: string): URLSearchParams {
  const next = new URLSearchParams(params);
  const on = next.get('yearFrom') === decade && next.get('yearTo') === String(Number(decade) + 9);
  next.delete('yearFrom');
  next.delete('yearTo');
  if (!on) {
    next.set('yearFrom', decade);
    next.set('yearTo', String(Number(decade) + 9));
  }
  return next;
}

/** Remove every filter, keep the sort and anything that is not Focus. */
export function clearFilters(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ALL_KEYS) if (key !== 'sort' && key !== 'order') next.delete(key);
  return next;
}

export interface ActiveFilter {
  /** Stable id for React and for tests. */
  id: string;
  label: string;
  remove: (params: URLSearchParams) => URLSearchParams;
}

const QUALITY_LABELS: Record<string, string> = { lossless: 'Lossless', hires: 'Hi-Res' };
const SOURCE_LABELS: Record<string, string> = { local: 'Local', qobuz: 'Qobuz', tidal: 'Tidal' };

/** Every active filter as a removable chip. `names` resolves composer and tag ids. */
export function activeFilters(
  params: URLSearchParams,
  names: Record<string, string> = {},
): ActiveFilter[] {
  const chips: ActiveFilter[] = [];
  const quality = params.get('quality');
  if (quality) {
    chips.push({
      id: `quality:${quality}`,
      label: QUALITY_LABELS[quality] ?? quality,
      remove: (p) => setValue(p, 'quality', undefined),
    });
  }
  for (const value of params.getAll('genre')) {
    chips.push({
      id: `genre:${value}`,
      label: value,
      remove: (p) => toggleValue(p, 'genre', value),
    });
  }
  const from = params.get('yearFrom');
  const to = params.get('yearTo');
  if (from || to) {
    const decade = from && to && Number(to) - Number(from) === 9 && Number(from) % 10 === 0;
    chips.push({
      id: 'year',
      label: decade ? `${from}s` : `${from ?? '…'}–${to ?? '…'}`,
      remove: (p) => setValue(setValue(p, 'yearFrom', undefined), 'yearTo', undefined),
    });
  }
  for (const value of params.getAll('format')) {
    chips.push({
      id: `format:${value}`,
      label: value.toUpperCase(),
      remove: (p) => toggleValue(p, 'format', value),
    });
  }
  for (const value of params.getAll('source')) {
    chips.push({
      id: `source:${value}`,
      label: SOURCE_LABELS[value] ?? value,
      remove: (p) => toggleValue(p, 'source', value),
    });
  }
  for (const value of params.getAll('label')) {
    chips.push({
      id: `label:${value}`,
      label: value,
      remove: (p) => toggleValue(p, 'label', value),
    });
  }
  for (const value of params.getAll('composer')) {
    chips.push({
      id: `composer:${value}`,
      label: names[value] ?? 'Composer',
      remove: (p) => toggleValue(p, 'composer', value),
    });
  }
  for (const value of params.getAll('tag')) {
    chips.push({
      id: `tag:${value}`,
      label: names[value] ? `# ${names[value]}` : 'Tag',
      remove: (p) => toggleValue(p, 'tag', value),
    });
  }
  for (const value of params.getAll('rule')) {
    chips.push({
      id: `rule:${value}`,
      label: ruleLabel(value),
      remove: (p) => toggleValue(p, 'rule', value),
    });
  }
  const flags: Array<[FocusScalarKey, string]> = [
    ['favorite', 'Favourites'],
    ['unplayed', 'Never played'],
    ['dedupeEditions', 'One edition per album'],
  ];
  for (const [key, label] of flags) {
    if (params.has(key)) chips.push({ id: key, label, remove: (p) => setValue(p, key, undefined) });
  }
  if (params.has('playedWithin')) {
    chips.push({
      id: 'playedWithin',
      label: `Played in the last ${params.get('playedWithin')} days`,
      remove: (p) => setValue(p, 'playedWithin', undefined),
    });
  }
  if (params.has('addedWithin')) {
    chips.push({
      id: 'addedWithin',
      label: `Added in the last ${params.get('addedWithin')} days`,
      remove: (p) => setValue(p, 'addedWithin', undefined),
    });
  }
  return chips;
}

const RULE_FIELDS: Record<string, string> = {
  genre: 'Genre',
  year: 'Year',
  format: 'Format',
  sampleRate: 'Sample rate',
  bitDepth: 'Bit depth',
  artistName: 'Artist',
};
const RULE_OPERATORS: Record<string, string> = {
  equals: 'is',
  contains: 'contains',
  greaterThan: '>',
  lessThan: '<',
};

/** A field condition (from an older smart playlist) in words: "Artist contains Davis". */
export function ruleLabel(json: string): string {
  try {
    const rule = JSON.parse(json) as {
      field: string;
      operator: string;
      value: string;
      value2?: string;
    };
    const field = RULE_FIELDS[rule.field] ?? rule.field;
    if (rule.operator === 'between') return `${field} ${rule.value}–${rule.value2 ?? rule.value}`;
    return `${field} ${RULE_OPERATORS[rule.operator] ?? rule.operator} ${rule.value}`;
  } catch {
    return 'Condition';
  }
}
