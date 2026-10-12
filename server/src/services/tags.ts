import { v4 as uuid } from 'uuid';
import { getRawDb } from '../db/index.js';

/**
 * Tags (R06.1): the listener's own order, apart from metadata — "Sunday
 * morning", "For the car", "Mum's favourites".
 *
 * The rules are the playlist rules of V09: a tag belongs to one person; a
 * shared tag is readable by the household and editable by nobody else; a tag
 * you may not see answers exactly like a tag that does not exist.
 */

export const TAG_ITEM_TYPES = ['album', 'artist', 'track', 'playlist'] as const;
export type TagItemType = (typeof TAG_ITEM_TYPES)[number];

export interface TagSummary {
  id: string;
  name: string;
  shared: boolean;
  /** True when the caller owns it (and so may edit it). */
  mine: boolean;
  /** Whose tag it is, for a shared tag of someone else. */
  ownerName: string | null;
  itemCount: number;
  counts: Record<TagItemType, number>;
}

export class TagNameTakenError extends Error {
  constructor(name: string) {
    super(`You already have a tag called "${name}"`);
    this.name = 'TagNameTakenError';
  }
}

export class UnknownTagItemError extends Error {
  constructor(type: string, id: string) {
    super(`No ${type} with id ${id}`);
    this.name = 'UnknownTagItemError';
  }
}

interface TagRow {
  id: string;
  user_id: string;
  name: string;
  shared: number;
  owner_name: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

const TRACK_FIELDS = `t.id, t.title, t.album_id as albumId, t.album_title as albumTitle,
  t.artist_id as artistId, t.artist_name as artistName, t.duration,
  t.track_number as trackNumber, t.disc_number as discNumber,
  t.format, t.sample_rate as sampleRate, t.bit_depth as bitDepth,
  t.replay_gain_track as replayGainTrack, t.replay_gain_track_peak as replayGainTrackPeak,
  t.source, t.availability`;

/** The SQL that says "a tag this user may read". */
export const VISIBLE_TAG_SQL = '(t.user_id = ? OR t.shared = 1)';

function summaries(rows: TagRow[], userId: string): TagSummary[] {
  if (rows.length === 0) return [];
  const counts = getRawDb()
    .prepare(
      `SELECT tag_id, item_type, COUNT(*) as n FROM tag_items
        WHERE tag_id IN (${rows.map(() => '?').join(',')})
          -- An album removed from the library is no longer counted.
          AND ((item_type = 'album' AND item_id IN (SELECT id FROM albums))
            OR (item_type = 'artist' AND item_id IN (SELECT id FROM artists))
            OR (item_type = 'track' AND item_id IN (SELECT id FROM tracks))
            OR (item_type = 'playlist' AND item_id IN (SELECT id FROM playlists)))
        GROUP BY tag_id, item_type`,
    )
    .all(...rows.map((r) => r.id)) as Array<{ tag_id: string; item_type: TagItemType; n: number }>;
  return rows.map((row) => {
    const own: Record<TagItemType, number> = { album: 0, artist: 0, track: 0, playlist: 0 };
    for (const c of counts) if (c.tag_id === row.id && c.item_type in own) own[c.item_type] = c.n;
    const mine = row.user_id === userId;
    return {
      id: row.id,
      name: row.name,
      shared: row.shared === 1,
      mine,
      ownerName: mine ? null : row.owner_name,
      itemCount: own.album + own.artist + own.track + own.playlist,
      counts: own,
    };
  });
}

const SELECT_TAGS = `SELECT t.id, t.user_id, t.name, t.shared, u.username as owner_name
                       FROM tags t LEFT JOIN users u ON u.id = t.user_id`;

/** Your tags first, then the household's shared ones, each A–Z. */
export function listTags(userId: string): TagSummary[] {
  const rows = getRawDb()
    .prepare(
      `${SELECT_TAGS} WHERE ${VISIBLE_TAG_SQL}
        ORDER BY (t.user_id = ?) DESC, t.name COLLATE NOCASE`,
    )
    .all(userId, userId) as TagRow[];
  return summaries(rows, userId);
}

/** A tag the user may read (`read`) or change (`write`), or null — never a hint which. */
export function findTag(id: string, userId: string, access: 'read' | 'write'): TagSummary | null {
  const row = getRawDb().prepare(`${SELECT_TAGS} WHERE t.id = ?`).get(id) as TagRow | undefined;
  if (!row) return null;
  const allowed = row.user_id === userId || (access === 'read' && row.shared === 1);
  return allowed ? summaries([row], userId)[0] : null;
}

export function createTag(userId: string, name: string, shared = false): TagSummary {
  const id = uuid();
  try {
    getRawDb()
      .prepare('INSERT INTO tags (id, user_id, name, shared, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, name, shared ? 1 : 0, now());
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new TagNameTakenError(name);
    throw err;
  }
  return findTag(id, userId, 'write')!;
}

export function updateTag(
  id: string,
  userId: string,
  changes: { name?: string; shared?: boolean },
): TagSummary | null {
  if (!findTag(id, userId, 'write')) return null;
  const db = getRawDb();
  try {
    if (changes.name !== undefined) {
      db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(changes.name, id);
    }
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new TagNameTakenError(changes.name!);
    throw err;
  }
  if (changes.shared !== undefined) {
    db.prepare('UPDATE tags SET shared = ? WHERE id = ?').run(changes.shared ? 1 : 0, id);
  }
  return findTag(id, userId, 'write');
}

export function deleteTag(id: string, userId: string): boolean {
  if (!findTag(id, userId, 'write')) return false;
  getRawDb().prepare('DELETE FROM tags WHERE id = ?').run(id);
  return true;
}

/**
 * Does the item exist, and may this person tag it? Library items are the
 * household's; a playlist only when it is theirs or shared (V09.2).
 */
function itemExists(type: TagItemType, id: string, userId: string): boolean {
  const db = getRawDb();
  const sql: Record<TagItemType, string> = {
    album: 'SELECT 1 FROM albums WHERE id = ?',
    artist: 'SELECT 1 FROM artists WHERE id = ?',
    track: 'SELECT 1 FROM tracks WHERE id = ?',
    playlist: 'SELECT 1 FROM playlists WHERE id = ? AND (user_id = ? OR shared = 1)',
  };
  const params = type === 'playlist' ? [id, userId] : [id];
  return !!db.prepare(sql[type]).get(...params);
}

/** Tag an item. Tagging twice is not an error. Null when the tag is not yours. */
export function addTagItem(
  tagId: string,
  userId: string,
  type: TagItemType,
  itemId: string,
): TagSummary | null {
  if (!findTag(tagId, userId, 'write')) return null;
  if (!itemExists(type, itemId, userId)) throw new UnknownTagItemError(type, itemId);
  getRawDb()
    .prepare(
      'INSERT OR IGNORE INTO tag_items (tag_id, item_type, item_id, added_at) VALUES (?, ?, ?, ?)',
    )
    .run(tagId, type, itemId, now());
  return findTag(tagId, userId, 'write');
}

export function removeTagItem(
  tagId: string,
  userId: string,
  type: TagItemType,
  itemId: string,
): TagSummary | null {
  if (!findTag(tagId, userId, 'write')) return null;
  getRawDb()
    .prepare('DELETE FROM tag_items WHERE tag_id = ? AND item_type = ? AND item_id = ?')
    .run(tagId, type, itemId);
  return findTag(tagId, userId, 'write');
}

/** The tags this person can see on one item — the chips on an album page. */
export function tagsOn(type: TagItemType, itemId: string, userId: string): TagSummary[] {
  const rows = getRawDb()
    .prepare(
      `${SELECT_TAGS} JOIN tag_items ti ON ti.tag_id = t.id
        WHERE ti.item_type = ? AND ti.item_id = ? AND ${VISIBLE_TAG_SQL}
        ORDER BY (t.user_id = ?) DESC, t.name COLLATE NOCASE`,
    )
    .all(type, itemId, userId, userId) as TagRow[];
  return summaries(rows, userId);
}

/**
 * What a tag holds, with enough of each item to show and play it. Playlists
 * are filtered for the reader: a shared tag never reveals a private playlist.
 */
export function tagItems(tagId: string, userId: string) {
  const db = getRawDb();
  const albums = db
    .prepare(
      `SELECT a.id, a.title, a.artist_id as artistId, a.artist_name as artistName,
              COALESCE(a.original_year, a.year) as year, a.cover_url as coverUrl,
              a.format, a.sample_rate as sampleRate, a.bit_depth as bitDepth, a.source
         FROM tag_items ti JOIN albums a ON a.id = ti.item_id
        WHERE ti.tag_id = ? AND ti.item_type = 'album'
        ORDER BY a.artist_name COLLATE NOCASE, COALESCE(a.original_year, a.year), a.title COLLATE NOCASE`,
    )
    .all(tagId);
  const artists = db
    .prepare(
      `SELECT ar.id, ar.name, ar.image_url as imageUrl
         FROM tag_items ti JOIN artists ar ON ar.id = ti.item_id
        WHERE ti.tag_id = ? AND ti.item_type = 'artist'
        ORDER BY ar.name COLLATE NOCASE`,
    )
    .all(tagId);
  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS}
         FROM tag_items ti JOIN tracks t ON t.id = ti.item_id
        WHERE ti.tag_id = ? AND ti.item_type = 'track'
        ORDER BY ti.added_at, t.title COLLATE NOCASE`,
    )
    .all(tagId);
  const playlists = db
    .prepare(
      `SELECT p.id, p.name, p.shared, (p.user_id = ?) as mine
         FROM tag_items ti JOIN playlists p ON p.id = ti.item_id
        WHERE ti.tag_id = ? AND ti.item_type = 'playlist' AND (p.user_id = ? OR p.shared = 1)
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all(userId, tagId, userId);
  return { albums, artists, tracks, playlists };
}

/**
 * Every playable track a tag stands for: its tracks, the tracks of its
 * albums, and of its artists — what "Shuffle" on a tag plays. Playlists are
 * left out: their items are a mix of sources with their own order.
 */
export function tagTracks(tagId: string): Array<Record<string, unknown>> {
  return getRawDb()
    .prepare(
      `SELECT ${TRACK_FIELDS} FROM tracks t
        WHERE COALESCE(t.availability, 'available') != 'missing' AND (
              t.id IN (SELECT item_id FROM tag_items WHERE tag_id = ? AND item_type = 'track')
           OR t.album_id IN (SELECT item_id FROM tag_items WHERE tag_id = ? AND item_type = 'album')
           OR t.artist_id IN (SELECT item_id FROM tag_items WHERE tag_id = ? AND item_type = 'artist'))
        ORDER BY t.album_title COLLATE NOCASE, t.album_id, t.disc_number, t.track_number`,
    )
    .all(tagId, tagId, tagId) as Array<Record<string, unknown>>;
}
