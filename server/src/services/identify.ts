import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import { lookupRelease, searchReleases, type ReleaseCandidate } from './musicbrainz.js';

/**
 * Identifying albums (R03.3).
 *
 * R03.2 reads the identity a file already carries. This job is for the rest:
 * the albums nobody tagged. It asks MusicBrainz for a release by artist,
 * title and track count, and then refuses to be clever. An album is linked
 * only when exactly one candidate agrees on all three; anything else becomes
 * a DOUBTFUL CASE that an admin decides by hand in Settings.
 *
 * That strictness is the point. A wrong MBID is worse than none: it would
 * put another record's label, release date and credits on your album, and
 * R07's Qobuz matching and R04's pages would build on it as if it were true.
 * "Not identified" is a usable answer; "identified as the wrong release" is
 * not.
 */

export interface IdentifyStatus {
  isRunning: boolean;
  total: number;
  processed: number;
  /** Albums that got an MBID from an unambiguous match. */
  linked: number;
  /** Albums with candidates but no single clear winner. */
  doubtful: number;
  /** Albums MusicBrainz had nothing for. */
  notFound: number;
  startedAt: number | null;
  finishedAt: number | null;
}

const idle = (): IdentifyStatus => ({
  isRunning: false,
  total: 0,
  processed: 0,
  linked: 0,
  doubtful: 0,
  notFound: 0,
  startedAt: null,
  finishedAt: null,
});

let status: IdentifyStatus = idle();

export function getIdentifyStatus(): IdentifyStatus {
  return { ...status };
}

interface AlbumRow {
  id: string;
  title: string;
  artist_id: string;
  artist_name: string;
  track_count: number | null;
}

/** Compare-form of a name: case, accents and punctuation are not identity. */
export function compareForm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** How sure a candidate has to be before it is accepted without a human. */
export const MIN_SCORE = 90;

/**
 * Pick the one candidate that is beyond doubt, or say there is none.
 *
 * Beyond doubt means: the artist and the title agree in compare-form, the
 * track count agrees, MusicBrainz' own score is at least `MIN_SCORE`, and no
 * other candidate meets all of that. Two releases that both qualify are a
 * genuine choice (a remaster, another country's pressing) and belong to the
 * admin, not to a coin flip.
 */
export function pickUnambiguous(
  album: { title: string; artistName: string; trackCount?: number | null },
  candidates: ReleaseCandidate[],
): { match: ReleaseCandidate | null; qualified: ReleaseCandidate[] } {
  const wantedTitle = compareForm(album.title);
  const wantedArtist = compareForm(album.artistName);
  const qualified = candidates.filter(
    (candidate) =>
      candidate.score >= MIN_SCORE &&
      compareForm(candidate.title) === wantedTitle &&
      compareForm(candidate.artist) === wantedArtist &&
      (!album.trackCount || !candidate.trackCount || candidate.trackCount === album.trackCount),
  );
  // Several releases of one album share a release group; when every qualified
  // candidate is the same release group, the album is still unambiguous — we
  // simply store the one MusicBrainz ranked first.
  const groups = new Set(qualified.map((c) => c.releaseGroupMbid ?? c.mbid));
  if (qualified.length === 1 || (qualified.length > 1 && groups.size === 1)) {
    return { match: qualified[0], qualified };
  }
  return { match: null, qualified };
}

function albumsToIdentify(): AlbumRow[] {
  try {
    return getRawDb()
      .prepare(
        `SELECT id, title, artist_id, artist_name, track_count
           FROM albums
          WHERE source = 'local'
            AND (mbid IS NULL OR mbid = '')
            AND title != 'Unknown Album'
          ORDER BY title`,
      )
      .all() as AlbumRow[];
  } catch (err) {
    logger.warn(`Identify: could not list albums: ${err}`);
    return [];
  }
}

/** Write what a release says about an album; an existing value is kept. */
export function applyIdentity(albumId: string, candidate: ReleaseCandidate): void {
  const db = getRawDb();
  db.prepare(
    `UPDATE albums
        SET mbid = ?,
            release_group_mbid = COALESCE(NULLIF(release_group_mbid, ''), ?),
            label = COALESCE(NULLIF(label, ''), ?),
            catalog_number = COALESCE(NULLIF(catalog_number, ''), ?),
            release_date = COALESCE(NULLIF(release_date, ''), ?)
      WHERE id = ?`,
  ).run(
    candidate.mbid,
    candidate.releaseGroupMbid ?? null,
    candidate.label ?? null,
    candidate.catalogNumber ?? null,
    candidate.date ?? null,
    albumId,
  );
  if (candidate.artistMbid) {
    db.prepare(
      `UPDATE artists SET mbid = ?
        WHERE id = (SELECT artist_id FROM albums WHERE id = ?)
          AND (mbid IS NULL OR mbid = '')`,
    ).run(candidate.artistMbid, albumId);
  }
  db.prepare('DELETE FROM album_identity_candidates WHERE album_id = ?').run(albumId);
}

function storeCandidates(albumId: string, candidates: ReleaseCandidate[]): void {
  const db = getRawDb();
  db.prepare('DELETE FROM album_identity_candidates WHERE album_id = ?').run(albumId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO album_identity_candidates
       (album_id, mbid, title, artist, release_group_mbid, label, catalog_number, date, track_count, score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const candidate of candidates.slice(0, 5)) {
    insert.run(
      albumId,
      candidate.mbid,
      candidate.title,
      candidate.artist,
      candidate.releaseGroupMbid ?? null,
      candidate.label ?? null,
      candidate.catalogNumber ?? null,
      candidate.date ?? null,
      candidate.trackCount ?? null,
      Math.round(candidate.score),
    );
  }
}

export interface DoubtfulAlbum {
  albumId: string;
  title: string;
  artistName: string;
  trackCount: number | null;
  candidates: Array<{
    mbid: string;
    title: string;
    artist: string;
    releaseGroupMbid: string | null;
    label: string | null;
    catalogNumber: string | null;
    date: string | null;
    trackCount: number | null;
    score: number;
  }>;
}

/** The albums waiting for a human decision, with what was found for them. */
export function listDoubtfulAlbums(): DoubtfulAlbum[] {
  try {
    const rows = getRawDb()
      .prepare(
        `SELECT c.album_id as albumId, a.title as title, a.artist_name as artistName,
                a.track_count as trackCount, c.mbid as mbid, c.title as candidateTitle,
                c.artist as candidateArtist, c.release_group_mbid as releaseGroupMbid,
                c.label as label, c.catalog_number as catalogNumber, c.date as date,
                c.track_count as candidateTrackCount, c.score as score
           FROM album_identity_candidates c
           JOIN albums a ON a.id = c.album_id
          WHERE a.mbid IS NULL OR a.mbid = ''
          ORDER BY a.title, c.score DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    const byAlbum = new Map<string, DoubtfulAlbum>();
    for (const row of rows) {
      const albumId = String(row.albumId);
      if (!byAlbum.has(albumId)) {
        byAlbum.set(albumId, {
          albumId,
          title: String(row.title),
          artistName: String(row.artistName),
          trackCount: (row.trackCount as number | null) ?? null,
          candidates: [],
        });
      }
      byAlbum.get(albumId)!.candidates.push({
        mbid: String(row.mbid),
        title: String(row.candidateTitle),
        artist: String(row.candidateArtist),
        releaseGroupMbid: (row.releaseGroupMbid as string | null) ?? null,
        label: (row.label as string | null) ?? null,
        catalogNumber: (row.catalogNumber as string | null) ?? null,
        date: (row.date as string | null) ?? null,
        trackCount: (row.candidateTrackCount as number | null) ?? null,
        score: Number(row.score ?? 0),
      });
    }
    return [...byAlbum.values()];
  } catch (err) {
    logger.warn(`Identify: could not list doubtful albums: ${err}`);
    return [];
  }
}

export class IdentifyChoiceError extends Error {
  constructor(readonly code: 'album_not_found' | 'release_not_found') {
    super(
      code === 'album_not_found'
        ? 'That album is not in the library'
        : 'MusicBrainz does not know that release id',
    );
    this.name = 'IdentifyChoiceError';
  }
}

/**
 * An admin's decision for one album. The release is looked up rather than
 * trusted from the stored candidate, so a hand-typed MBID is also checked
 * before it becomes this album's identity.
 */
export async function chooseIdentity(albumId: string, mbid: string): Promise<DoubtfulAlbum | null> {
  const album = getRawDb().prepare('SELECT id FROM albums WHERE id = ?').get(albumId);
  if (!album) throw new IdentifyChoiceError('album_not_found');
  const release = await lookupRelease(mbid);
  if (!release) throw new IdentifyChoiceError('release_not_found');
  applyIdentity(albumId, release);
  logger.info(`Identify: ${albumId} linked to release ${mbid} by hand`);
  return null;
}

/** Forget the candidates of an album without linking any of them. */
export function dismissCandidates(albumId: string): boolean {
  const changes = getRawDb()
    .prepare('DELETE FROM album_identity_candidates WHERE album_id = ?')
    .run(albumId).changes;
  return changes > 0;
}

/**
 * Look up every album without an MBID. Runs in the background behind the
 * shared one-request-per-second limit, so a library of a thousand unidentified
 * albums takes about twenty minutes and disturbs nothing else.
 */
export async function identifyAlbums(): Promise<IdentifyStatus> {
  if (status.isRunning) return getIdentifyStatus();
  const albums = albumsToIdentify();
  status = { ...idle(), isRunning: true, total: albums.length, startedAt: Date.now() };
  logger.info(`Identify: ${albums.length} album(s) without a MusicBrainz id`);

  try {
    for (const album of albums) {
      try {
        const candidates = await searchReleases({
          artist: album.artist_name,
          title: album.title,
          trackCount: album.track_count ?? undefined,
        });
        if (candidates.length === 0) {
          status.notFound += 1;
        } else {
          const { match, qualified } = pickUnambiguous(
            { title: album.title, artistName: album.artist_name, trackCount: album.track_count },
            candidates,
          );
          if (match) {
            applyIdentity(album.id, match);
            status.linked += 1;
          } else {
            // Store what was found, including the near misses: the admin needs
            // to see why this was not obvious.
            storeCandidates(album.id, qualified.length > 0 ? qualified : candidates);
            status.doubtful += 1;
          }
        }
      } catch (err) {
        logger.warn(`Identify: ${album.title} failed: ${err}`);
        status.notFound += 1;
      }
      status.processed += 1;
    }
  } finally {
    status.isRunning = false;
    status.finishedAt = Date.now();
    logger.info(
      `Identify: done — ${status.linked} linked, ${status.doubtful} doubtful, ${status.notFound} not found`,
    );
  }
  return getIdentifyStatus();
}

/** Test helper: forget the job's status without touching the database. */
export function resetIdentifyForTests(): void {
  status = idle();
}
