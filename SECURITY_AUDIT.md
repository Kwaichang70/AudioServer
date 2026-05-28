# Security Audit - Qobuz Release

Date: 2026-05-28

## Scope

This audit covers the production dependency surface after the Qobuz playback
work. The usable audit result is from:

```bash
npm audit --omit=dev --json
```

The full external audit was not rerun after sandbox review because npm audit
sends dependency metadata to the npm audit service. Keep that privacy tradeoff
explicit when rerunning this on private code.

Local dependency-tree context was checked with:

```bash
npm ls music-metadata file-type drizzle-orm node-ssdp ip express qs express-rate-limit ip-address socket.io ws uuid lodash --all
```

## Result

Production audit result:

- Critical: 0
- High: 5
- Moderate: 11
- Total: 16

## Priority Fixes

### P1 - Audio metadata parser DoS

Packages:

- `music-metadata@10.9.1`
- `file-type@19.6.0`, via `music-metadata`

Risk:

The scanner parses files from the NAS music library. A malformed ASF/WMA file
can trigger parser issues in this dependency chain. This is relevant because
the app scans user-controlled media files.

Plan:

- Upgrade `music-metadata` to the fixed 11.x line in a dedicated dependency
  branch.
- Run server tests and a manual NAS scan.
- Verify WMA/MP3/FLAC parsing and cover extraction.

Do not use `npm audit fix --force` for this because it can apply broad major
updates without project-specific validation.

### P1 - Drizzle ORM SQL identifier issue

Package:

- `drizzle-orm@0.38.4`

Risk:

The reported issue concerns escaped SQL identifiers. Current app queries are
mostly static and internal, so exposure appears lower than raw user-supplied
identifier usage, but it is still a direct high-severity dependency.

Plan:

- Upgrade Drizzle to the fixed 0.45.x line in the same dependency pass or a
  separate migration pass.
- Run repository/search/library tests.
- Manually verify existing SQLite database startup and migrations.

### P1/P2 - Device discovery dependency chain

Packages:

- `node-ssdp@4.0.1`
- `ip@1.1.9`, via `node-ssdp`
- `lodash@4.17.23`, via `node-ssdp -> async`

Risk:

The audit recommends a problematic `node-ssdp` major change. This code path is
limited to LAN device discovery, but it still touches network inputs.

Plan:

- Do not blindly downgrade/major-switch `node-ssdp`.
- Review whether `node-ssdp` can be replaced, patched, or isolated.
- Keep device discovery disabled in tests by default.
- Keep production deployment on a trusted LAN only.

### P2 - Express request parsing chain

Packages:

- `express@4.22.1`
- `body-parser@1.20.4`
- `qs@6.14.2`

Risk:

The reported `qs` issue can affect stringification with comma arrays. The app
does not intentionally expose that behavior as a core feature, but Express is a
public HTTP boundary.

Plan:

- Update Express/body-parser/qs within the non-breaking fixed range when
  available in the lockfile.
- Run API route tests and a production build.

### P2 - Rate limit address parser

Packages:

- `express-rate-limit@8.3.2`
- `ip-address@10.1.0`

Risk:

The audit flags HTML-emitting helper methods in `ip-address`. The app uses this
through rate limiting, not direct HTML rendering, so practical exposure appears
low.

Plan:

- Update `express-rate-limit` and `ip-address`.
- Verify login/auth and API rate-limit behavior.

### P2 - Socket transport chain

Packages:

- `socket.io@4.8.3`
- `engine.io@6.6.6`
- `engine.io-client@6.6.4`
- `socket.io-adapter@2.5.6`
- `ws@8.18.3`

Risk:

The reported `ws` issue is transitive. The app uses Socket.IO for realtime
client updates.

Plan:

- Update Socket.IO packages and lockfile.
- Verify realtime playback/device/library updates in the browser.

### P3 - UUID bounds check

Package:

- `uuid@11.1.0`

Risk:

Direct dependency with a moderate advisory. The likely fix is a small patch
upgrade.

Plan:

- Update to the fixed patch release.
- Run typecheck and tests.

## Recommended Remediation Order

1. `music-metadata` and scanner verification.
2. Drizzle upgrade and SQLite verification.
3. `node-ssdp` replacement or containment decision.
4. Express/rate-limit/socket/uuid lockfile refresh.

## Acceptance Criteria

- `npm audit --omit=dev` no longer reports high-severity production issues, or
  any remaining high issue has a written exception.
- `npm run typecheck` passes.
- Server and client tests pass.
- A manual NAS scan completes without deleting valid tracks.
- Browser playback, Qobuz playback, local playback, and device discovery are
  smoke-tested after dependency changes.
