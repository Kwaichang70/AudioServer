import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { searchText } from '../utils/search-text.js';

/**
 * Accent-free search (R05.4): "Dvorak" finds "Dvořák". Folded copies of the
 * searched text are kept by triggers, whoever writes; genres, composers and
 * conductors are searchable too.
 */

describe('searchText', () => {
  it('folds accents, case and letters that do not decompose', () => {
    expect(searchText('Antonín Dvořák')).toBe('antonin dvorak');
    expect(searchText('Björk')).toBe('bjork');
    expect(searchText('Sigur Rós')).toBe('sigur ros');
    expect(searchText('Søren Løkke Juul')).toBe('soren lokke juul');
    expect(searchText('Straße')).toBe('strasse');
    expect(searchText('Łódź')).toBe('lodz');
    expect(searchText('Ｂｅｅｔｈｏｖｅｎ  ﬁve')).toBe('beethoven five');
  });

  it('leaves other scripts as they were typed', () => {
    expect(searchText('宇多田ヒカル')).toBe('宇多田ヒカル');
    // A voicing mark is part of the letter in Japanese: ガ is not カ.
    expect(searchText('ガ')).not.toBe(searchText('カ'));
    expect(searchText('Пётр Чайковский')).toBe('петр чаиковскии');
  });
});

describe('Searching without accents', () => {
  let app: Express;
  let teardown: () => void;
  let dbPath: string;

  const search = async (q: string) =>
    (await request(app).get(`/api/library/search?q=${encodeURIComponent(q)}`)).body.data as {
      artists: Array<{ id: string }>;
      albums: Array<{ id: string }>;
      tracks: Array<{ id: string }>;
    };
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    dbPath = ctx.dbPath;
    getRawDb().exec(`
      INSERT INTO artists (id, name) VALUES
        ('ar-dvorak', 'Antonín Dvořák'), ('ar-czech', 'Česká filharmonie'),
        ('ar-talich', 'Václav Talich'), ('ar-bjork', 'Björk'), ('ar-hikaru', '宇多田ヒカル');
      INSERT INTO albums (id, title, artist_id, artist_name, genre) VALUES
        ('al-new-world', 'Symphonie Nr. 9 „Aus der neuen Welt“', 'ar-czech', 'Česká filharmonie', 'Klassiek'),
        ('al-homogenic', 'Homogenic', 'ar-bjork', 'Björk', 'Pop'),
        ('al-first-love', 'First Love', 'ar-hikaru', '宇多田ヒカル', 'J-Pop');
      INSERT INTO album_genres (album_id, genre) VALUES ('al-homogenic', 'Électronique');
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, composer, conductor) VALUES
        ('t-largo', 'II. Largo', 'al-new-world', 'Symphonie Nr. 9 „Aus der neuen Welt“', 'ar-czech',
         'Česká filharmonie', 'Antonín Dvořák', 'Václav Talich'),
        ('t-joga', 'Jóga', 'al-homogenic', 'Homogenic', 'ar-bjork', 'Björk', NULL, NULL),
        ('t-automatic', 'Automatic', 'al-first-love', 'First Love', 'ar-hikaru', '宇多田ヒカル', NULL, NULL);
    `);
  });

  afterAll(() => teardown());

  it('finds Dvořák as "Dvorak": the composer, and his music through the credits', async () => {
    const found = await search('Dvorak');
    expect(ids(found.artists)).toEqual(['ar-dvorak']);
    expect(ids(found.tracks)).toEqual(['t-largo']);
  });

  it('finds names and titles typed without accents, in any case', async () => {
    expect(ids((await search('bjork')).artists)).toEqual(['ar-bjork']);
    expect(ids((await search('JOGA')).tracks)).toEqual(['t-joga']);
    expect(ids((await search('ceska')).albums)).toEqual(['al-new-world']);
    expect(ids((await search('neuen welt')).albums)).toEqual(['al-new-world']);
  });

  it('searches genres for albums and conductors for tracks', async () => {
    expect(ids((await search('electronique')).albums)).toEqual(['al-homogenic']);
    expect(ids((await search('Talich')).tracks)).toEqual(['t-largo']);
  });

  it('still finds Japanese as typed', async () => {
    expect(ids((await search('ヒカル')).artists)).toEqual(['ar-hikaru']);
  });

  it('ranks a title match above a credit-only match', async () => {
    getRawDb().exec(`
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name)
      VALUES ('t-humoresque', 'Humoresque (after Dvořák)', 'al-homogenic', 'Homogenic', 'ar-bjork', 'Björk');
    `);
    expect(ids((await search('dvorak')).tracks)).toEqual(['t-humoresque', 't-largo']);
    getRawDb().exec(`DELETE FROM tracks WHERE id = 't-humoresque'`);
  });

  describe('kept current by triggers', () => {
    it('follows a rename', async () => {
      getRawDb().exec(`UPDATE artists SET name = 'Björk Guðmundsdóttir' WHERE id = 'ar-bjork'`);
      expect(ids((await search('gudmundsdottir')).artists)).toEqual(['ar-bjork']);
    });

    it('follows genres and credits written later, in their own tables', async () => {
      const db = getRawDb();
      db.exec(`DELETE FROM album_genres WHERE album_id = 'al-homogenic'`);
      expect(ids((await search('electronique')).albums)).toEqual([]);
      db.exec(`INSERT INTO track_artists (track_id, artist_id, role, position)
               VALUES ('t-joga', 'ar-talich', 'conductor', 0)`);
      expect(ids((await search('vaclav')).tracks).sort()).toEqual(['t-joga', 't-largo']);
      db.exec(`DELETE FROM track_artists WHERE track_id = 't-joga'`);
      expect(ids((await search('vaclav')).tracks)).toEqual(['t-largo']);
    });

    it('fills rows from before this version once, on start', async () => {
      getRawDb().exec(`
        UPDATE artists SET name_norm = NULL;
        UPDATE albums SET title_norm = NULL, artist_norm = NULL, genre_norm = NULL;
        UPDATE tracks SET title_norm = NULL, artist_norm = NULL, album_norm = NULL, credits_norm = NULL;
      `);
      expect(ids((await search('Dvorak')).artists)).toEqual([]);
      closeDatabase();
      await initDatabase(dbPath);
      const found = await search('Dvorak');
      expect(ids(found.artists)).toEqual(['ar-dvorak']);
      expect(ids(found.tracks)).toEqual(['t-largo']);
    });
  });
});
