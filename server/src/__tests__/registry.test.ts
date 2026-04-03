import { describe, it, expect } from 'vitest';

// Test the dedup logic standalone
describe('Search deduplication', () => {
  function dedup<T extends { source?: string }>(items: T[], keyFn: (item: T) => string): T[] {
    const seen = new Map<string, T>();
    const sourceOrder: Record<string, number> = { local: 0, qobuz: 1, tidal: 2, spotify: 3 };

    for (const item of items) {
      const key = keyFn(item);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, item);
      } else {
        const existingPriority = sourceOrder[existing.source || 'spotify'] ?? 9;
        const newPriority = sourceOrder[item.source || 'spotify'] ?? 9;
        if (newPriority < existingPriority) {
          seen.set(key, item);
        }
      }
    }

    return Array.from(seen.values());
  }

  it('removes duplicate artists, keeps local over spotify', () => {
    const items = [
      { name: 'Prince', source: 'local' },
      { name: 'Prince', source: 'spotify' },
      { name: 'Queen', source: 'spotify' },
    ];
    const result = dedup(items, (a) => a.name.toLowerCase());
    expect(result).toHaveLength(2);
    expect(result.find((a) => a.name === 'Prince')?.source).toBe('local');
  });

  it('keeps higher priority source (qobuz > spotify)', () => {
    const items = [
      { name: 'Miles Davis', source: 'spotify' },
      { name: 'Miles Davis', source: 'qobuz' },
    ];
    const result = dedup(items, (a) => a.name.toLowerCase());
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('qobuz');
  });

  it('removes duplicate albums by artist+title', () => {
    const items = [
      { title: 'Purple Rain', artistName: 'Prince', source: 'local' },
      { title: 'Purple Rain', artistName: 'Prince', source: 'spotify' },
      { title: 'Purple Rain', artistName: 'Prince', source: 'tidal' },
      { title: '1999', artistName: 'Prince', source: 'spotify' },
    ];
    const result = dedup(items, (a) => `${a.artistName}-${a.title}`.toLowerCase());
    expect(result).toHaveLength(2);
    expect(result.find((a) => a.title === 'Purple Rain')?.source).toBe('local');
  });

  it('handles empty input', () => {
    expect(dedup([], (a: any) => a.name)).toEqual([]);
  });

  it('handles unique items', () => {
    const items = [
      { name: 'A', source: 'local' },
      { name: 'B', source: 'spotify' },
      { name: 'C', source: 'tidal' },
    ];
    const result = dedup(items, (a) => a.name);
    expect(result).toHaveLength(3);
  });
});
