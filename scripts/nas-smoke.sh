#!/bin/sh
# Post-deploy smoke check (plan §6/§7.5). Run it on the NAS after
# `docker-compose up -d --build`, and again after a rollback:
#
#   sh scripts/nas-smoke.sh                       # http://localhost:3001
#   sh scripts/nas-smoke.sh http://localhost:3001 21 e0ba630
#                           base URL              schema  build id (optional)
#
# The build id is what VCS_REF was at build time (DEPLOY_SYNOLOGY.md §3).
# It only reads: no login, no playback, nothing is written. Exit code 0 means
# every check passed; each failed check prints FAIL and the script exits 1.

BASE="${1:-http://localhost:3001}"
WANT_SCHEMA="${2:-}"
WANT_BUILD="${3:-}"
WAIT="${SMOKE_WAIT_SECONDS:-120}"
TMP="$(mktemp -d 2>/dev/null || echo /tmp/audioserver-smoke.$$)"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

failures=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}
# status <path> [file]: HTTP status of a GET, body saved to file (or discarded)
status() {
  # curl itself prints 000 when nothing answers.
  curl -s -o "${2:-/dev/null}" -w '%{http_code}' --max-time 15 "$BASE$1" 2>/dev/null
  return 0
}
# json_field <file> <name>: first "name":value in a JSON file (string or number)
json_field() {
  sed -n "s/.*\"$2\":\"\{0,1\}\([^\",}]*\).*/\1/p" "$1" | head -n 1
}

echo "AudioServer smoke check against $BASE"

# 1. Ready: the database is open and migrated. Wait for a container that is
#    still starting, up to $WAIT seconds.
i=0
code=$(status /api/health/ready "$TMP/ready")
while [ "$code" != 200 ] && [ "$i" -lt "$WAIT" ]; do
  sleep 2
  i=$((i + 2))
  code=$(status /api/health/ready "$TMP/ready")
done
if [ "$code" = 200 ]; then
  ok "ready after ${i}s"
else
  fail "/api/health/ready answered $code after ${WAIT}s"
  echo "Not ready; the remaining checks would only repeat that. Logs:"
  echo "  sudo docker logs --tail=80 audioserver_audioserver_1"
  exit 1
fi

schema=$(json_field "$TMP/ready" schemaVersion)
if [ -z "$WANT_SCHEMA" ]; then
  ok "schema version $schema"
elif [ "$schema" = "$WANT_SCHEMA" ]; then
  ok "schema version $schema (expected)"
else
  fail "schema version $schema, expected $WANT_SCHEMA"
fi

# 2. The web app: the page, its service worker and every script and stylesheet
#    the page names. A release that is only half there fails here, not in the
#    browser.
code=$(status / "$TMP/index.html")
if [ "$code" = 200 ] && grep -q '<div id="root"' "$TMP/index.html"; then
  ok "web app page"
else
  fail "web app page answered $code (client/dist missing from the image?)"
fi
code=$(status /sw.js "$TMP/sw.js")
# The release id is "<build id>-<content hash>": the build id is the VCS_REF
# the image was built with, so it says which commit is running.
release=$(sed -n "s/.*RELEASE_ID = ['\"]\([^'\"]*\).*/\1/p" "$TMP/sw.js" | head -n 1)
if [ "$code" = 200 ] && [ -n "$release" ] && [ "$release" != __RELEASE_ID__ ]; then
  ok "service worker, release $release"
else
  fail "service worker answered $code or has no release id"
fi
if [ -n "$WANT_BUILD" ]; then
  case "$release" in
    "$WANT_BUILD"-*) ok "running build $WANT_BUILD" ;;
    *) fail "running release '$release', expected build $WANT_BUILD (VCS_REF not passed to the build?)" ;;
  esac
fi
assets=$(grep -o '/assets/[^"'"'"' ]*\.\(js\|css\)' "$TMP/index.html" | sort -u)
if [ -z "$assets" ]; then
  fail "the page names no /assets/ files"
else
  n=0
  bad=""
  for a in $assets; do
    n=$((n + 1))
    [ "$(status "$a")" = 200 ] || bad="$bad $a"
  done
  if [ -z "$bad" ]; then ok "$n page assets load"; else fail "assets missing:$bad"; fi
fi

# 3. Access control: the library is closed without a session, so an image
#    that came up "open" is caught.
code=$(status /api/library/albums)
if [ "$code" = 401 ]; then
  ok "library needs a login (401)"
else
  fail "library without login answered $code, expected 401"
fi

# 4. Realtime: the Socket.IO handshake answers (the session check comes after).
code=$(status '/socket.io/?EIO=4&transport=polling')
if [ "$code" = 200 ]; then
  ok "realtime handshake"
else
  fail "realtime handshake answered $code"
fi

if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
  exit 0
fi
echo "$failures check(s) failed."
exit 1
