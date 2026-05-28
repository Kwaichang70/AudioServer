# Next Improvement Decision

Date: 2026-05-28

## Selected Next Improvement

Make library scanning safe when NAS paths are temporarily unavailable.

## Why This Is Next

The scanner is one of the few parts of the app that can change a large amount
of persistent state. If a configured NAS path is offline, permission-blocked, or
temporarily unavailable, orphan cleanup must not interpret that as "all tracks
under this path were deleted".

This has higher operational risk than another UI improvement because it can
damage the library database state even when the music files are still present.

## Success Criteria

- A failed or unreachable music root never causes existing tracks under that
  root to be deleted from the database.
- Orphan cleanup only runs for roots that were scanned successfully.
- If no roots scan successfully, orphan cleanup is skipped.
- The scan status reports failed roots and whether orphan cleanup was skipped.
- Tests cover:
  - inaccessible configured root
  - one successful root plus one failed root
  - real deleted file under a successful root
  - moved/renamed file behavior

## Implementation Outline

1. Track scan state per configured root:
   - root path
   - success/failure
   - error message
   - files seen under that root
2. Change orphan cleanup to accept only successful roots.
3. Skip orphan cleanup entirely when every root failed.
4. Persist or expose scan diagnostics so the UI can show a useful warning.
5. Add route/service tests before touching deployment.

## Backlog After This

- Apply the dependency remediation plan from `SECURITY_AUDIT.md`.
- Clean up static/API route ordering so SPA fallback never masks API 404s.
- Add graceful shutdown for SQLite, Socket.IO, and discovery timers.
- Split browser audio analysis from playback so external cross-origin streams
  never trigger WebAudio CORS noise.
- Revisit Spotify OAuth redirect URI setup when NAS access is available.
