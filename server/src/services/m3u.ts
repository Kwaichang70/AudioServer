/**
 * M3U import and export helpers (ANALYSE_EN_VERBETERPLAN B11).
 *
 * Import matches each line to exactly one library track, or says it could
 * not: an exact path, the same path with other slashes, the same album
 * folder and file name, the file name alone when only one track has it, and
 * for a file name several tracks share, the #EXTINF "artist - title" before
 * it. "song.flac" never matches "other-song.flac", and two albums with a
 * "01.flac" are reported as ambiguous instead of the first one being taken.
 */

export interface LibraryFile {
  id: string;
  filePath: string;
  title: string;
  artistName: string;
}

export interface M3uEntry {
  line: string;
  /** "artist - title" from the #EXTINF before it, when there was one. */
  label?: string;
}

export type M3uMatch =
  | { kind: 'matched'; trackId: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: number };

/** The entries of an M3U: each path line with the #EXTINF label before it. */
export function parseM3u(content: string): M3uEntry[] {
  const entries: M3uEntry[] = [];
  let label: string | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      label = line.slice(line.indexOf(',') + 1).trim() || undefined;
      continue;
    }
    if (line.startsWith('#')) continue;
    entries.push({ line, label });
    label = undefined;
  }
  return entries;
}

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/(?<!^)\/{2,}/g, '/');
const baseName = (p: string) => slashes(p).split('/').pop() ?? '';
const tail = (p: string, n: number) => slashes(p).split('/').slice(-n).join('/').toLowerCase();
const loose = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** One lookup structure for a whole import, instead of a table scan per line. */
export function buildIndex(files: LibraryFile[]) {
  const exact = new Map<string, LibraryFile>();
  const normalized = new Map<string, LibraryFile>();
  const byName = new Map<string, LibraryFile[]>();
  for (const f of files) {
    exact.set(f.filePath, f);
    normalized.set(slashes(f.filePath).toLowerCase(), f);
    const name = baseName(f.filePath).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), f]);
  }
  return { exact, normalized, byName };
}

export function matchEntry(index: ReturnType<typeof buildIndex>, entry: M3uEntry): M3uMatch {
  const hit =
    index.exact.get(entry.line) ?? index.normalized.get(slashes(entry.line).toLowerCase());
  if (hit) return { kind: 'matched', trackId: hit.id };

  const candidates = index.byName.get(baseName(entry.line).toLowerCase()) ?? [];
  if (candidates.length === 0) return { kind: 'missing' };
  if (candidates.length === 1) return { kind: 'matched', trackId: candidates[0].id };

  // Several tracks share the file name: the folder it was in, then the label.
  for (const depth of [3, 2]) {
    const same = candidates.filter((c) => tail(c.filePath, depth) === tail(entry.line, depth));
    if (same.length === 1) return { kind: 'matched', trackId: same[0].id };
  }
  if (entry.label) {
    const want = loose(entry.label);
    const same = candidates.filter((c) => loose(`${c.artistName} - ${c.title}`) === want);
    if (same.length === 1) return { kind: 'matched', trackId: same[0].id };
  }
  return { kind: 'ambiguous', candidates: candidates.length };
}

/**
 * A Content-Disposition value for any playlist name: an ASCII fallback plus
 * the real name UTF-8 encoded (RFC 6266). A raw name with an emoji, Japanese
 * or a line break made Node refuse the header — a 500 instead of a file.
 */
export function attachmentHeader(name: string, extension: string): string {
  const clean = name.replace(/[\r\n\t]+/g, ' ').trim() || 'playlist';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/]/g, '_');
  const encoded = encodeURIComponent(`${clean}${extension}`).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}${extension}"; filename*=UTF-8''${encoded}`;
}

/** Text for one M3U line: no line breaks inside it. */
export function m3uText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}
