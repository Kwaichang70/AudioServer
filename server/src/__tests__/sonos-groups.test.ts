import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { zones } from '../services/zones.js';
import { configureSonosGroups, resetSonosGroups } from '../services/sonos-groups.js';

/**
 * Sonos groups (R09.1): a room plays along with another in sync; the group
 * is one room, and the member cannot be steered on its own until it leaves.
 */

const track = { id: 't1', title: 'One', artistName: 'A', albumTitle: 'B', duration: 200 };

describe('Sonos groups', () => {
  let app: Express;
  let teardown: () => void;
  let kitchen: string;
  let bedroom: string;
  let office: string;
  let living: string;
  // The topology as Sonos would report it: member device → leader device.
  const follows = new Map<string, string>();
  const sent: string[] = [];
  let refuse = false;

  const as = (zoneId: string) => ({
    post: (path: string) =>
      request(app).post(path).set('X-Client-Id', 'group-test').set('X-Zone-Id', zoneId),
  });
  const overview = async () =>
    (await request(app).get('/api/playback/zones')).body.data as Array<{
      id: string;
      groupable: boolean;
      groupedWith: string | null;
      groupMembers: string[];
    }>;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    const make = async (name: string, deviceId: string) =>
      (await request(app).post('/api/playback/zones').send({ name, deviceId })).body.data.id;
    kitchen = await make('Kitchen', 'RINCON_K');
    bedroom = await make('Bedroom', 'RINCON_B');
    office = await make('Office', 'RINCON_O');
    living = await make('Living room', 'dlna:living');
    configureSonosGroups({
      isGroupable: (id) => id.startsWith('RINCON_'),
      join: async (member, leader) => {
        if (refuse) throw new Error('UPnP fault 800');
        sent.push(`join ${member}→${leader}`);
        follows.set(member, leader);
      },
      leave: async (member) => {
        sent.push(`leave ${member}`);
        follows.delete(member);
      },
      refresh: async () => {},
      coordinatorOf: (id) => follows.get(id) ?? null,
      membersOf: (id) => [...follows].filter(([, leader]) => leader === id).map(([m]) => m),
    });
  });

  beforeEach(() => {
    follows.clear();
    sent.length = 0;
    refuse = false;
  });

  afterAll(() => {
    resetSonosGroups();
    teardown();
  });

  it('lets the bedroom play along with the kitchen, and stops what the bedroom played', async () => {
    await as(bedroom)
      .post('/api/playback/queue/set')
      .send({ tracks: [track], startIndex: 0, commandId: 'b-play' });
    expect(zones.sessionFor(bedroom).getState().state).toBe('playing');
    const res = await as(kitchen).post('/api/playback/group').send({ memberZoneId: bedroom });
    expect(res.status).toBe(200);
    expect(sent).toEqual(['join RINCON_B→RINCON_K']);
    expect(res.body.data).toEqual({ groupable: true, groupedWith: null, groupMembers: [bedroom] });
    expect(zones.sessionFor(bedroom).getState().state).toBe('stopped');
    // Its own queue stays, for when it leaves again.
    expect(zones.sessionFor(bedroom).getQueue()).toHaveLength(1);

    const rooms = await overview();
    expect(rooms.find((z) => z.id === bedroom)).toMatchObject({ groupedWith: kitchen });
    expect(rooms.find((z) => z.id === kitchen)).toMatchObject({ groupMembers: [bedroom] });
    expect(rooms.find((z) => z.id === living)).toMatchObject({ groupable: false });
  });

  it('does not let a member be steered on its own, but still answers reads', async () => {
    follows.set('RINCON_B', 'RINCON_K');
    const play = await as(bedroom).post('/api/playback/play').send({});
    expect(play.status).toBe(409);
    expect(play.body.error).toBe('GroupedZone');
    expect(play.body.message).toMatch(/plays along with “Kitchen”/);
    const read = await request(app).get('/api/playback/session').set('X-Zone-Id', bedroom);
    expect(read.status).toBe(200);
    // Nor can music be moved into it.
    await as(kitchen)
      .post('/api/playback/queue/set')
      .send({ tracks: [track], startIndex: 0, commandId: 'k-play' });
    const move = await as(kitchen).post('/api/playback/transfer').send({ toZoneId: bedroom });
    expect(move.status).toBe(409);
    expect(move.body.error).toBe('target_grouped');
  });

  it('takes the bedroom out again, from the bedroom itself', async () => {
    follows.set('RINCON_B', 'RINCON_K');
    const res = await request(app)
      .post('/api/playback/ungroup')
      .set('X-Client-Id', 'group-test')
      .set('X-Zone-Id', bedroom)
      .send({ memberZoneId: bedroom });
    expect(res.status).toBe(200);
    expect(sent).toEqual(['leave RINCON_B']);
    expect(res.body.data.groupedWith).toBeNull();
    const play = await as(bedroom).post('/api/playback/play').send({});
    expect(play.status).toBe(200);
  });

  it('refuses what Sonos cannot do, with a reason', async () => {
    const dlna = await as(kitchen).post('/api/playback/group').send({ memberZoneId: living });
    expect(dlna.status).toBe(409);
    expect(dlna.body.error).toBe('not_groupable');
    const self = await as(kitchen).post('/api/playback/group').send({ memberZoneId: kitchen });
    expect(self.body.error).toBe('same_zone');
    // The office leads its own group: it cannot simply be pulled into another.
    follows.set('RINCON_B', 'RINCON_O');
    const leader = await as(kitchen).post('/api/playback/group').send({ memberZoneId: office });
    expect(leader.body.error).toBe('member_leads_group');
    const notGrouped = await as(kitchen)
      .post('/api/playback/ungroup')
      .send({ memberZoneId: kitchen });
    expect(notGrouped.body.error).toBe('not_grouped');
    refuse = true;
    follows.clear();
    const refused = await as(kitchen).post('/api/playback/group').send({ memberZoneId: office });
    expect(refused.status).toBe(502);
    expect(refused.body.message).toMatch(/did not join/);
  });
});
