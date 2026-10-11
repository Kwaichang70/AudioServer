import { describe, expect, it } from 'vitest';
import {
  activeFilters,
  clearFilters,
  filterCount,
  focusQueryString,
  setValue,
  toggleDecade,
  toggleValue,
} from '../focus.js';

/** Focus in the URL (R05.2): one filter, one stable string. */

const p = (s: string) => new URLSearchParams(s);

describe('Focus URL helpers', () => {
  it('turns the same filter into the same string, whatever the order', () => {
    expect(focusQueryString(p('genre=Rock&genre=Jazz&sort=year'))).toBe(
      focusQueryString(p('sort=year&genre=Jazz&genre=Rock')),
    );
    // Keys that are not Focus stay out of it.
    expect(focusQueryString(p('tab=2&genre=Jazz'))).toBe('genre=Jazz');
  });

  it('toggles values within a facet (OR) and keeps other facets (AND)', () => {
    let q = toggleValue(p('quality=hires'), 'genre', 'Jazz');
    q = toggleValue(q, 'genre', 'Blues');
    expect(q.getAll('genre')).toEqual(['Jazz', 'Blues']);
    q = toggleValue(q, 'genre', 'Jazz');
    expect(q.getAll('genre')).toEqual(['Blues']);
    expect(q.get('quality')).toBe('hires');
  });

  it('treats a decade as one year range that toggles', () => {
    const on = toggleDecade(p(''), '1970');
    expect([on.get('yearFrom'), on.get('yearTo')]).toEqual(['1970', '1979']);
    expect(filterCount(on)).toBe(1);
    const other = toggleDecade(on, '1980');
    expect(other.get('yearFrom')).toBe('1980');
    expect(toggleDecade(other, '1980').has('yearFrom')).toBe(false);
  });

  it('counts filters but not the sort, and clears filters but keeps the sort', () => {
    const q = p('sort=plays&order=desc&genre=Jazz&genre=Blues&unplayed=true&tab=x');
    expect(filterCount(q)).toBe(3);
    const cleared = clearFilters(q);
    expect(cleared.toString()).toBe('sort=plays&order=desc&tab=x');
  });

  it('lists active filters as removable chips with readable labels', () => {
    const q = p('quality=hires&genre=Jazz&yearFrom=1970&yearTo=1979&unplayed=true&composer=ar-1');
    const chips = activeFilters(q, { 'ar-1': 'Antonín Dvořák' });
    expect(chips.map((c) => c.label)).toEqual([
      'Hi-Res',
      'Jazz',
      '1970s',
      'Antonín Dvořák',
      'Never played',
    ]);
    const year = chips.find((c) => c.id === 'year')!;
    expect(year.remove(q).has('yearFrom')).toBe(false);
    expect(setValue(q, 'quality', undefined).has('quality')).toBe(false);
  });
});
