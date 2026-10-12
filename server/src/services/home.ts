import { getRawDb } from '../db/index.js';
import { localMix, type MixItem } from './recommendations.js';

/**
 * Home as an overview (R08.2): where you left off, what is new, the genres
 * you play, and a mix for today — all from this server, no external account.
 * "For you" from ListenBrainz is fetched separately by the client: it may be
 * slow or absent, and Home must not wait for it.
 */

export interface ContinueItem {
  albumId: string;
  title: string;
  artistName: string;
  coverUrl: string | null;
  lastPlayed: number;
  /** The track to resume with: the one you stopped in, or the next. */
  resumeTrackId: string | null;
  resumeTitle: string | null;
  /** Seconds into it when you stopped mid-track; 0 to start it fresh. */
  resumePosition: number;
  /** How far through the album, 0..1. */
  progress: number;
}

export interface GenreForYou {
  genre: string;
  plays: number;
  albumIds: string[];
}

export interface HomeData {
  continueListening: ContinueItem[];
  newInLibrary: Array<{
    id: string;
    title: string;
    artistName: string;
    coverUrl: string | null;
    source: string;
    createdAt: number | null;
  }>;
  genresForYou: GenreForYou[];
  dailyMix: { date: string; items: MixItem[]; basis: string };
}

const db = () => getRawDb();

/** A session that stopped early counts as "in the middle of" that track. */
const UNFINISHED_SHARE = 0.9;

export function continueListening(userId: string, limit = 10): ContinueItem[] {
  const albums = db()
    .prepare(
      `SELECT s.album_id, MAX(s.started_at) as last_played
         FROM listening_sessions s JOIN albums a ON a.id = s.album_id
        WHERE s.user_id = ? AND s.album_id IS NOT NULL AND s.started_at IS NOT NULL
          AND s.status != 'active'
        GROUP BY s.album_id ORDER BY last_played DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<{ album_id: string; last_played: number }>;
  const out: ContinueItem[] = [];
  for (const { album_id: albumId, last_played: lastPlayed } of albums) {
    const album = db()
      .prepare('SELECT id, title, artist_name, cover_url FROM albums WHERE id = ?')
      .get(albumId) as { id: string; title: string; artist_name: string; cover_url: string | null };
    const tracks = db()
      .prepare(
        `SELECT id, title, duration FROM tracks
          WHERE album_id = ? AND COALESCE(availability, 'available') NOT IN ('missing', 'unavailable')
          ORDER BY disc_number, track_number, title`,
      )
      .all(albumId) as Array<{ id: string; title: string; duration: number | null }>;
    if (tracks.length === 0) continue;
    const last = db()
      .prepare(
        `SELECT track_id, listened_ms, duration FROM listening_sessions
          WHERE user_id = ? AND album_id = ? AND started_at = ? LIMIT 1`,
      )
      .get(userId, albumId, lastPlayed) as
      | { track_id: string | null; listened_ms: number; duration: number | null }
      | undefined;
    const index = tracks.findIndex((t) => t.id === last?.track_id);
    let resumeIndex = 0;
    let resumePosition = 0;
    if (index >= 0) {
      const length = last?.duration ?? tracks[index].duration ?? 0;
      const heard = (last?.listened_ms ?? 0) / 1000;
      if (length > 0 && heard < length * UNFINISHED_SHARE) {
        resumeIndex = index;
        resumePosition = Math.floor(heard);
      } else {
        resumeIndex = index + 1;
      }
    }
    // Finished the album: it is not "in progress" any more.
    if (resumeIndex >= tracks.length) continue;
    out.push({
      albumId,
      title: album.title,
      artistName: album.artist_name,
      coverUrl: album.cover_url,
      lastPlayed,
      resumeTrackId: tracks[resumeIndex].id,
      resumeTitle: tracks[resumeIndex].title,
      resumePosition,
      progress: tracks.length ? resumeIndex / tracks.length : 0,
    });
  }
  return out;
}

export function newInLibrary(limit = 12): HomeData['newInLibrary'] {
  return db()
    .prepare(
      `SELECT id, title, artist_name as artistName, cover_url as coverUrl, source,
              created_at as createdAt
         FROM albums ORDER BY created_at DESC, title LIMIT ?`,
    )
    .all(limit) as HomeData['newInLibrary'];
}

/** The genres you played most in the last 90 days; the library's own when you played nothing yet. */
export function genresForYou(userId: string, limit = 6): GenreForYou[] {
  const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  let rows = db()
    .prepare(
      `SELECT g.genre as genre, COUNT(*) as plays
         FROM listening_sessions s JOIN album_genres g ON g.album_id = s.album_id
        WHERE s.user_id = ? AND s.qualified = 1 AND s.started_at >= ?
        GROUP BY g.genre ORDER BY plays DESC, g.genre LIMIT ?`,
    )
    .all(userId, since, limit) as Array<{ genre: string; plays: number }>;
  if (rows.length === 0) {
    rows = (
      db()
        .prepare(
          `SELECT genre, COUNT(*) as n FROM album_genres GROUP BY genre ORDER BY n DESC, genre LIMIT ?`,
        )
        .all(limit) as Array<{ genre: string; n: number }>
    ).map((r) => ({ genre: r.genre, plays: 0 }));
  }
  const covers = db().prepare(
    `SELECT a.id FROM albums a JOIN album_genres g ON g.album_id = a.id
      WHERE g.genre = ? ORDER BY a.created_at DESC LIMIT 4`,
  );
  return rows.map((r) => ({
    genre: r.genre,
    plays: r.plays,
    albumIds: (covers.all(r.genre) as Array<{ id: string }>).map((c) => c.id),
  }));
}

/** Local calendar date: a "daily" mix changes at midnight here, not in UTC. */
export function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Today's mix: made once a day from your history (localMix), kept for the
 * day — also across a restart — so it is the same mix every time you look.
 * Tracks that stopped being playable since the morning are left out.
 */
export function dailyMix(userId: string, date = today()): HomeData['dailyMix'] {
  const stored = db()
    .prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'home.dailyMix'")
    .get(userId) as { value: string | null } | undefined;
  if (stored?.value) {
    try {
      const parsed = JSON.parse(stored.value) as HomeData['dailyMix'];
      if (parsed.date === date) {
        const playable = new Set(
          (
            db()
              .prepare(
                `SELECT id FROM tracks WHERE id IN (${parsed.items.map(() => '?').join(',') || "''"})
                   AND COALESCE(availability, 'available') NOT IN ('missing', 'unavailable')`,
              )
              .all(...parsed.items.map((i) => i.id)) as Array<{ id: string }>
          ).map((r) => r.id),
        );
        return { ...parsed, items: parsed.items.filter((i) => playable.has(i.id)) };
      }
    } catch {
      // A broken entry is simply replaced below.
    }
  }
  const mix = localMix(userId, { limit: 25 });
  const daily = { date, items: mix.items, basis: mix.basis };
  db()
    .prepare(
      `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, 'home.dailyMix', ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(userId, JSON.stringify(daily), Math.floor(Date.now() / 1000));
  return daily;
}

export function homeData(userId: string): HomeData {
  return {
    continueListening: continueListening(userId),
    newInLibrary: newInLibrary(),
    genresForYou: genresForYou(userId),
    dailyMix: dailyMix(userId),
  };
}
