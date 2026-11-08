import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, seedUser, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { relinkMissingTrack } from '../services/scanner.js';

/**
 * ANALYSE_EN_VERBETERPLAN B01: relinking a missing track (and the album
 * folder it left) keeps every person's own favourites, ratings and tags.
 * Before, someone else's favourite on the target made the code drop all
 * favourites of the missing track, and ratings and tags stayed behind.
 */
describe('relink keeps everyone their own marks', () => {
  let teardown: () => void;
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    teardown = (await createTestApp({ auth: 'none' })).teardown;
    a = await seedUser('anna', 'admin');
    b = await seedUser('bram', 'user');
    getRawDb().exec(`
      INSERT INTO artists (id, name) VALUES ('ar', 'Miles Davis');
      INSERT INTO albums (id, title, artist_id, artist_name) VALUES
        ('al-old', 'Kind of Blue', 'ar', 'Miles Davis'),
        ('al-new', 'Kind of Blue', 'ar', 'Miles Davis');
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path, availability) VALUES
        ('t-gone', 'So What', 'al-old', 'Kind of Blue', 'ar', 'Miles Davis', '/old/so-what.flac', 'missing'),
        ('t-here', 'So What', 'al-new', 'Kind of Blue', 'ar', 'Miles Davis', '/new/so-what.flac', 'available'),
        ('t-both', 'Blue in Green', 'al-new', 'Kind of Blue', 'ar', 'Miles Davis', '/new/big.flac', 'available'),
        ('t-both-old', 'Blue in Green', 'al-old', 'Kind of Blue', 'ar', 'Miles Davis', '/old/big.flac', 'missing');
    `);
    const db = getRawDb();
    const fav = db.prepare('INSERT INTO favorites (item_type, item_id, user_id) VALUES (?, ?, ?)');
    const rate = db.prepare(
      'INSERT INTO ratings (user_id, item_type, item_id, rating) VALUES (?, ?, ?, ?)',
    );
    db.prepare("INSERT INTO tags (id, user_id, name) VALUES ('tag-a', ?, 'Zondag')").run(a.id);
    const tag = db.prepare(
      "INSERT INTO tag_items (tag_id, item_type, item_id) VALUES ('tag-a', ?, ?)",
    );
    // Anna marked the old file; Bram marked the new one.
    fav.run('track', 't-gone', a.id);
    rate.run(a.id, 'track', 't-gone', 5);
    tag.run('track', 't-gone');
    fav.run('track', 't-here', b.id);
    rate.run(b.id, 'track', 't-here', 2);
    // Anna has both versions of the other track as a favourite and rated both.
    fav.run('track', 't-both-old', a.id);
    fav.run('track', 't-both', a.id);
    rate.run(a.id, 'track', 't-both-old', 1);
    rate.run(a.id, 'track', 't-both', 4);
    // The album: Anna's favourite and rating on the old folder, Bram's on the new.
    fav.run('album', 'al-old', a.id);
    rate.run(a.id, 'album', 'al-old', 5);
    fav.run('album', 'al-new', b.id);
  });

  afterAll(() => teardown());

  const marks = (itemId: string) => {
    const db = getRawDb();
    return {
      favorites: (
        db
          .prepare('SELECT user_id FROM favorites WHERE item_id = ? ORDER BY user_id')
          .all(itemId) as Array<{ user_id: string }>
      ).map((r) => r.user_id),
      ratings: db
        .prepare('SELECT user_id, rating FROM ratings WHERE item_id = ? ORDER BY user_id')
        .all(itemId),
      tags: db.prepare('SELECT tag_id FROM tag_items WHERE item_id = ?').all(itemId),
    };
  };

  it('moves Anna’s favourite, rating and tag to the new file, next to Bram’s', () => {
    expect(relinkMissingTrack('t-gone', 't-here')).toMatchObject({ favorites: 1 });
    const here = marks('t-here');
    expect(here.favorites.sort()).toEqual([a.id, b.id].sort());
    expect(here.ratings).toEqual(
      expect.arrayContaining([
        { user_id: a.id, rating: 5 },
        { user_id: b.id, rating: 2 },
      ]),
    );
    expect(here.tags).toEqual([{ tag_id: 'tag-a' }]);
    expect(marks('t-gone')).toEqual({ favorites: [], ratings: [], tags: [] });
  });

  it('keeps one favourite and the newer version’s rating when someone marked both', () => {
    relinkMissingTrack('t-both-old', 't-both');
    const both = marks('t-both');
    expect(both.favorites).toEqual([a.id]);
    expect(both.ratings).toEqual([{ user_id: a.id, rating: 4 }]);
  });

  it('moves album marks to the folder that took over, per person', () => {
    // Both old tracks are relinked: the old album folder is empty and pruned.
    expect(getRawDb().prepare("SELECT id FROM albums WHERE id = 'al-old'").get()).toBeUndefined();
    const album = marks('al-new');
    expect(album.favorites.sort()).toEqual([a.id, b.id].sort());
    expect(album.ratings).toEqual([{ user_id: a.id, rating: 5 }]);
  });
});
