# Security Audit - Dependencies

Date: 2026-09-08 (sprint V01.2 of [VERBETERPLAN_SPRINTS.md](VERBETERPLAN_SPRINTS.md))
Supersedes: the 2026-05-28 Qobuz-release audit (see git history for that text).

## Scope

Production dependency surface as installed from a clean `npm ci` on Node 22
(production runtime) and Node 24 (development). Source of truth:

```bash
npm audit --omit=dev --json
```

`npm audit` sends dependency metadata to the npm audit service; keep that in
mind when re-running it on private code. CI runs the same command on every
push as a report-only step (`.github/workflows/ci.yml`), so the picture below
is refreshed automatically; this document records the assessment.

## Result

| Date       | Critical | High | Moderate | Low | Packages |
| ---------- | -------- | ---- | -------- | --- | -------- |
| 2026-09-07 | 0        | 11   | 6        | 2   | 19       |
| 2026-09-08 | 0        | 2    | 0        | 0   | 2        |

Both remaining findings are the same dependency chain (`node-ssdp -> ip`),
see "Accepted findings" below. The development tree has four more moderate
findings, all in `drizzle-kit`'s bundled esbuild; they never ship.

## What changed

Fixes were applied in small groups; the full suite (server + client tests,
lint, typecheck, build, startup smoke test) was run after each group.

1. **Transport, parsers, helpers (lockfile-only, `npm audit fix`).**
   `socket.io`/`engine.io`/`ws`/`socket.io-parser`/`socket.io-adapter`,
   `express-rate-limit` + `ip-address`, `body-parser`, `lodash`,
   `react-router`/`react-router-dom` (7.14.1 -> 7.18.3), `uuid`, `esbuild` via
   `tsx`. All inside the existing semver ranges.
2. **`qs` (query-string parser under Express).** The fixed release (6.16.0)
   lies outside the `~6.15.1` range Express 4.22.2 declares, so the root
   `package.json` carries an npm `overrides` entry. Remove the override once
   Express itself depends on `>=6.16.0`.
3. **`music-metadata` 10.6 -> 11.15 (major).** Fixes the ASF-parser infinite
   loop (GHSA-v6c2-xwv6-8xf7, GHSA-5v7r-6r5c-r473). Relevant: the scanner
   parses every file on the NAS share, so one malformed WMA file could have
   pinned a scan forever. The `@ts-expect-error` shims on `parseFile` were
   removed because 11.x ships correct ESM types. Verified with the scanner and
   cover-art suites plus a parse of a generated WAV under `node --import
tsx/esm`.
4. **`drizzle-orm` 0.38 -> 0.45.2 and `drizzle-kit` 0.30 -> 0.31 (major).**
   Fixes GHSA-gpj5-g38j-94v9 (identifier escaping). The app never builds SQL
   identifiers from user input, so the reachable risk was low, but a direct
   high-severity dependency with a clean upgrade path is not worth an
   exception. Migrations, the version guard and the backup/restore suite run
   against the new version.
5. **Express 4.22.1 -> 4.22.2, tsx 4.19 -> 4.23** (minor/patch, needed for
   the `qs` and `esbuild` ranges).

## Accepted findings

### `node-ssdp@4.0.1` -> `ip@1.1.9` (high, GHSA-2p57-rm9w-gvfp)

- **What the advisory covers:** `ip.isPublic()` / `isPrivate()` misclassify
  some addresses, which matters when an application uses those helpers to
  decide whether a URL is safe to fetch (SSRF guard).
- **What AudioServer executes:** `node-ssdp` calls only `ip.address()` to
  build its own SSDP `LOCATION` header (`node_modules/node-ssdp/lib/index.js`,
  one call site). Neither the app nor `node-ssdp` calls `isPublic`/`isPrivate`.
  The vulnerable function is not on any reachable code path.
- **Why no upgrade:** 4.0.1 is the newest `node-ssdp` release and still pins
  `ip@^1.1.5`; `ip@2.0.1` carries the same advisory. `npm audit fix --force`
  would _downgrade_ to `node-ssdp@1.0.0`, which is an unrelated old API. Not a
  remediation.
- **Mitigation in place:** discovery only runs on the LAN (`network_mode:
host`), the SSDP client never fetches operator-controlled URLs based on an
  `ip` classification, and discovery is disabled in tests.
- **Owner:** Danny de Lacombe. **Review date:** 2026-12-01, or earlier when
  either `node-ssdp` publishes a release without `ip`, or the device layer is
  reworked in sprint V10/E03 (then evaluate replacing `node-ssdp` with a small
  in-house SSDP client, which is roughly 150 lines of `dgram`).

### `drizzle-kit` -> `@esbuild-kit/*` -> `esbuild@0.18` (moderate, dev only)

- Development-only tooling for `npm run db:generate`; not installed in the
  production image (`npm prune --omit=dev` in the Dockerfile) and never
  listening on a port in this project. The advisory concerns esbuild's dev
  server. No action beyond tracking `drizzle-kit` releases; re-check at the
  same review date.

## Verification performed

- `npm ci` on a clean tree, then `npm run lint`, `npm run typecheck`,
  `npm test` (server 158, client 84), `npm run build`.
- Startup/shutdown smoke test (`server/src/__tests__/startup-smoke.test.ts`)
  boots the real entrypoint on the upgraded tree.
- Production image build + readiness + graceful stop run in CI (`docker` job).

Not verified in this pass (needs the NAS and hardware): a full library scan of
the real collection with `music-metadata` 11, Sonos/DLNA discovery with the
current `node-ssdp`, and Qobuz playback. Those are the acceptance steps for the
next NAS deployment (see [docs/backup-restore.md](docs/backup-restore.md) for
the update procedure that includes them).

## Re-running the audit

```bash
npm ci
npm audit --omit=dev            # production surface
npm audit                       # including dev tooling
npm ls ip node-ssdp qs music-metadata drizzle-orm --all
```

Rules of thumb:

- Never run `npm audit fix --force` on this repository; it proposes major
  downgrades (`node-ssdp@1.0.0`) as "fixes".
- Apply fixes in groups (transport, parser, database), run the whole suite
  after each group, and record any new exception here with an owner and date.
