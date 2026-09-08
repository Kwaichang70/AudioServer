# Backup, restore, update and rollback

Runbook for the SQLite database and the configuration that goes with it.
Introduced in sprint V01.4; every data migration from now on re-runs the
"restore on an empty installation" check below.

## What must be backed up

| Item                        | Where (Docker on the NAS)                                                     | Why                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database                    | `/data/audioserver.db` in the `audioserver-data` volume                       | Accounts, library index, playlists, favorites, history, queue, provider tokens                                                                                                                                      |
| Environment / secrets       | `/volume1/docker/AudioServer/.env`                                            | `JWT_SECRET` signs sessions **and** derives the key that encrypts provider tokens in the database. A database restored without the matching `JWT_SECRET` has unusable provider tokens and every user is logged out. |
| Compose file + image inputs | `/volume1/docker/AudioServer/docker-compose.yml`, the deployed source archive | Needed to rebuild the exact image for a rollback                                                                                                                                                                    |

Music files are not part of this: the library is re-scannable, the database is
not.

The database is never a plain file copy. It runs in WAL mode, so
`cp audioserver.db` misses committed writes that still live in
`audioserver.db-wal` and can copy a half-written page. Use the scripts below;
they use SQLite's online backup API and produce one self-contained file.

## Scripts

All three read `DATABASE_PATH` (and the rest of the environment) the same way
the server does, so inside the container they need no arguments.

| Command                                                   | What it does                                                                                                                                                                    | Safe while the server runs?   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `npm run db:backup --workspace=server -- [file]`          | Consistent snapshot to `file` (default `<db dir>/backups/audioserver-<timestamp>.db`). Refuses to overwrite. Prints schema version + row counts.                                | Yes                           |
| `npm run db:verify --workspace=server -- [file]`          | Read-only: `integrity_check`, schema version vs. this build, row counts. Exit 1 on corruption or a schema from a newer build.                                                   | Yes                           |
| `npm run db:restore --workspace=server -- <file> [--yes]` | Replaces `DATABASE_PATH` with the backup. Without `--yes` it is a dry run. Moves the old database to `*.pre-restore-<timestamp>`; refuses while the database is open elsewhere. | **No**, stop the server first |

Inside the container:

```bash
docker exec audioserver npm run db:backup --workspace=server -- /data/backups/before-update.db
docker exec audioserver npm run db:verify --workspace=server -- /data/backups/before-update.db
```

(`docker compose ps` shows the container name; with the repo compose file it is
`audioserver-audioserver-1` unless `container_name` is set.)

## Schema version and rollback safety

After migrating, the server writes its schema version into `PRAGMA
user_version` (`SCHEMA_VERSION` in `server/src/db/index.ts`). On startup an
older build that finds a **higher** version refuses to start:

```
Database schema version 2 is newer than this build supports (1). Start the
build that created it, or restore a backup taken before the upgrade
```

That is the explicit compatibility check the rollback procedure relies on:
"the old image starts" is only a valid rollback when the database is one the
old image understands. Databases from before this check carry version 0 and
are accepted (and upgraded) by every build.

`GET /api/health/ready` reports `db.schemaVersion` and
`db.expectedSchemaVersion` so the check can be read remotely.

## Scheduled backups

Synology Task Scheduler (root, daily, e.g. 04:00):

```bash
#!/bin/sh
set -e
STAMP=$(date +%Y%m%d-%H%M)
docker exec audioserver-audioserver-1 npm run db:backup --workspace=server -- /data/backups/audioserver-$STAMP.db
docker exec audioserver-audioserver-1 npm run db:verify --workspace=server -- /data/backups/audioserver-$STAMP.db
# keep 14 days
docker exec audioserver-audioserver-1 find /data/backups -name 'audioserver-*.db' -mtime +14 -delete
```

Copy `/volume1/docker/AudioServer/.env` to the same backup location whenever
it changes (Hyper Backup or a second line in the task). The volume path on
the host is shown by `docker volume inspect audioserver-data`.

## Update procedure

1. **Backup first.** `db:backup` + `db:verify` as above, and note the output
   (schema version, users, tracks, playlists). Keep the `.env` copy.
2. Deploy the new source and rebuild (`DEPLOY_SYNOLOGY.md`, sections 2–3).
3. **Wait for readiness, not just "up":**
   ```bash
   until curl -fsS http://localhost:3001/api/health/ready; do sleep 2; done
   ```
   The Docker `HEALTHCHECK` uses the same endpoint; `docker ps` shows
   `(healthy)` once it passes.
4. Check `db.schemaVersion` in the readiness output against the value the
   release notes mention.
5. Acceptance: log in, open an album, play a local track, play a Qobuz track,
   check one device, run a library scan on a small folder. For dependency
   releases (see `SECURITY_AUDIT.md`) also let a full scan finish and confirm
   the track count did not drop.

## Rollback procedure

Two cases, decided by the schema version:

**A. The new build did not change the schema** (`db.schemaVersion` unchanged
after the update): redeploy the previous archive and rebuild
(`DEPLOY_SYNOLOGY.md` section 6). The database stays as it is.

**B. The new build migrated the database** (version went up), or you are not
sure:

```bash
cd /volume1/docker/AudioServer
sudo /usr/local/bin/docker-compose down
# restore the previous source archive, then:
sudo /usr/local/bin/docker-compose up -d --build
```

The old image will refuse to start with the newer database (see above). That
is expected. Restore the pre-update backup:

```bash
docker exec -it audioserver-audioserver-1 npm run db:restore --workspace=server -- /data/backups/before-update.db --yes
```

If the old container is in a restart loop because of the version error, run
the restore from a one-off container on the same volume instead:

```bash
docker run --rm -v audioserver-data:/data -e DATABASE_PATH=/data/audioserver.db \
  -e JWT_SECRET=$(grep ^JWT_SECRET= .env | cut -d= -f2-) -e NODE_ENV=production \
  audioserver-audioserver npm run db:restore --workspace=server -- /data/backups/before-update.db --yes
```

Then `docker compose up -d`, wait for `/api/health/ready`, and repeat the
acceptance checks. Listening history and playlist changes made between the
backup and the rollback are lost; that window is the reason step 1 of every
update is a fresh backup.

## Restore on an empty installation (disaster recovery)

1. New NAS/container with the same `.env` (`JWT_SECRET` in particular).
2. Start once so the volume and migrations exist, then stop.
3. `db:restore <backup> --yes`, start again, wait for `/api/health/ready`.
4. Verify: `db:verify` counts match the backup's output; log in with an
   existing account; open a playlist; the history page shows old plays; the
   Settings page still shows the provider as connected (token decrypts).
5. Run a library scan. Tracks keep their IDs when the file paths are
   unchanged, so favorites and playlists stay attached. If the music share is
   mounted under a different path, fix the mount before scanning; sprint V06
   covers path moves without losing relations.

The automated version of steps 3–4 is
`server/src/__tests__/db-backup.test.ts`: it takes an online backup of a live
database with an account, library rows, a playlist and history, restores it
to a fresh location, boots it through `initDatabase()` and reads every row
back. It runs in CI on every push.

## Measurements

| Check                                            | Result (2026-09-08)                                               |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Backup + verify + restore, 0.16 MB test database | < 1 s each (Linux container, Node 22)                             |
| Production image: start to `/api/health/ready`   | 3 s; Docker `healthy` after 4 s; `docker stop` exit 0 (CI run 50) |
| Restore on the NAS-size database                 | not measured yet; record here at the first NAS restore            |
