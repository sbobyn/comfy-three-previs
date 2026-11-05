#!/usr/bin/env bash
# Publish this checkout to the public repo and its GitHub Pages demo, in one go:
#   1. preflight: clean tree, pushed to $SOURCE_REMOTE, the `films` release exists, `pnpm check && pnpm test`,
#      secret/path scan
#   2. verify HEAD is the existing canonical remote branch tip; never create or rewrite code history
#   3. demo: `pnpm run demo:build` against a temporary read-only server on a copy of the data with the bundled
#      starters imported into it, uploaded as demo-site.tar.gz to the `demo-site` release (not git), then deployed
#      by the Pages workflow (scripts/publish-pages.sh), which adds launch-film*.mp4 from the `films` release
#   4. verify: every demo file on the live site matches dist-demo, the films are served, headless Chrome loads
#      every starter with no console errors and plays the films
# Never creates code commits or pushes code. The films are published separately by
# scripts/publish-films.sh TRAILER_DIR VERSION.
#
#   PUBLIC_REMOTE   remote to publish to (default origin)
#   PUBLIC_BRANCH   code branch (default main)
#   SOURCE_REMOTE   HEAD must already be on a branch of this remote (default origin; ALLOW_UNPUSHED=1 skips)
#   SOURCE_DATA     server data dir to snapshot the demo from (default .evidence/dev-data; copied, never written).
#                   The starters always come from examples/starters, imported into the copy.
#   DEMO_MEDIA_MB   demo media budget (default 400); the publish stops if the snapshot skips any media
#   PAGES_URL       demo URL (default https://<owner>.github.io/<repo>/ from the remote)
#   DEMO_PORT       port for the temporary server (default: first free port from 5320)
#   COMMIT_TRAILER  optional line appended to the publish commit message
#   DRY_RUN=1       build and pack the demo, but upload and deploy nothing
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
PUBLIC_REMOTE=${PUBLIC_REMOTE:-origin}
PUBLIC_BRANCH=${PUBLIC_BRANCH:-main}
DEMO_TAG=demo-site
FILMS_TAG=films
FILMS="launch-film.mp4 launch-film-1x1.mp4 launch-film-9x16.mp4 launch-film-30s.mp4"
SOURCE_REMOTE=${SOURCE_REMOTE:-origin}
SOURCE_DATA=${SOURCE_DATA:-.evidence/dev-data}
DRY_RUN=${DRY_RUN:-0}
COMMIT_TRAILER=${COMMIT_TRAILER:-}

say() { printf '\n== %s\n' "$*"; }
die() { printf 'publish: %s\n' "$*" >&2; exit 1; }

SLUG=$(git remote get-url "$PUBLIC_REMOTE" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
OWNER=${SLUG%%/*}; REPO=${SLUG#*/}
PAGES_URL=${PAGES_URL:-https://$(printf %s "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$REPO/}
SHA=$(git rev-parse HEAD); SHORT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

TMP=$(mktemp -d "${TMPDIR:-/tmp}/publish-public.XXXXXX")
SERVER_PID=
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---------------------------------------------------------------- 1. preflight
say "preflight: $BRANCH @ $SHORT → $SLUG"
git diff --quiet && git diff --cached --quiet || die "working tree has uncommitted changes"
[ -z "$(git ls-files --others --exclude-standard)" ] || die "untracked files present: $(git ls-files --others --exclude-standard | head -5 | tr '\n' ' ')"
git fetch -q "$SOURCE_REMOTE"
if [ "${ALLOW_UNPUSHED:-0}" != 1 ] && [ -z "$(git branch -r --contains "$SHA" | grep " $SOURCE_REMOTE/" || true)" ]; then
  die "HEAD $SHORT is not on any $SOURCE_REMOTE branch — push it first (or ALLOW_UNPUSHED=1)"
fi

for name in $FILMS; do
  gh api "repos/$SLUG/releases/tags/$FILMS_TAG" --jq ".assets[] | select(.name == \"$name\") | .name" 2>/dev/null | grep -qx "$name" \
    || die "release $FILMS_TAG has no $name: run scripts/publish-films.sh TRAILER_DIR VERSION first"
done
echo "films: release $FILMS_TAG has $(echo $FILMS | wc -w | tr -d ' ') films"

say "gate: pnpm check && pnpm test"
pnpm check >"$TMP/check.log" 2>&1 || { tail -30 "$TMP/check.log"; die "pnpm check failed"; }
pnpm test >"$TMP/test.log" 2>&1 || { tail -40 "$TMP/test.log"; die "pnpm test failed"; }
{ grep -E '^# (pass|fail|skipped)' "$TMP/test.log" || true; } | tr '\n' ' '; echo

# Key-like strings. Character classes keep this file from matching itself.
# `api_key` only counts when assigned a 16+ character literal (test fixtures use short placeholders).
B='(^|[^A-Za-z0-9_])'  # word start; \b is not portable across grep and git grep
SECRET_RE="${B}sk-[A-Za-z0-9_-]{20,}|${B}AKIA[0-9A-Z]{16}|${B}gh[pousr]_[A-Za-z0-9]{30,}|${B}xox[abprs]-[A-Za-z0-9-]{10,}|${B}comfy_[A-Za-z0-9_-]{16,}|"'eyJhbGci[O]i|api_key["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_-]{16,}'
PATH_RE='/[U]sers/'
# Exact values of any credentials configured on this machine.
: >"$TMP/known"; chmod 600 "$TMP/known"
for v in COMFY_CLOUD_API_KEY COMFY_API_KEY; do
  val=${!v:-}; [ -n "$val" ] && printf '%s\n' "$val" >>"$TMP/known"
  [ -f .env ] && sed -nE "s/^[[:space:]]*$v[[:space:]]*=[[:space:]]*['\"]?([^'\"[:space:]]{8,}).*/\1/p" .env >>"$TMP/known"
done
scan_dir() { # $1 = directory about to be published
  local hits
  hits=$(grep -rIEn --exclude-dir=.git -e "$SECRET_RE" -e "$PATH_RE" "$1" | cut -c1-200 || true)
  [ -s "$TMP/known" ] && hits+=$'\n'$(grep -rIlF --exclude-dir=.git -f "$TMP/known" "$1" | sed 's/$/: contains a configured credential value/' || true)
  [ -z "${hits//[[:space:]]/}" ] || { printf '%s\n' "$hits" >&2; die "secret/path scan hit in $1"; }
}

say "secret scan: tracked tree"
tracked_env=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v -E '\.env\.example$' || true)
[ -z "$tracked_env" ] || die ".env file(s) tracked: $tracked_env"
hits=$(git grep -n -I -E -e "$SECRET_RE" -e "$PATH_RE" "$SHA" | cut -c1-200 || true)
[ -s "$TMP/known" ] && hits+=$'\n'$(git grep -l -I -F -f "$TMP/known" "$SHA" | sed 's/$/: contains a configured credential value/' || true)
[ -z "${hits//[[:space:]]/}" ] || { printf '%s\n' "$hits" >&2; die "secret/path scan hit in tracked files"; }
echo "clean ($(git ls-files | wc -l | tr -d ' ') files)"

# The canonical repository already contains the release commit. Never create snapshot commits.
[ "$PUBLIC_REMOTE" = "$SOURCE_REMOTE" ] || die "Use one canonical remote for source and publication"
git fetch -q "$PUBLIC_REMOTE"
[ "$(git rev-parse "$PUBLIC_REMOTE/$PUBLIC_BRANCH")" = "$SHA" ] || die "Push the intended commit to $PUBLIC_REMOTE/$PUBLIC_BRANCH before publishing"
MAIN_SHA=$SHA

# ---------------------------------------------------------------- 3. demo
[ -d "$SOURCE_DATA" ] || die "SOURCE_DATA $SOURCE_DATA not found"
port=${DEMO_PORT:-5320}
if [ -z "${DEMO_PORT:-}" ]; then while (: <"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do port=$((port + 1)); done; fi
say "demo: read-only server on :$port (copy of $SOURCE_DATA)"
# A live server may be writing to SOURCE_DATA (temp files vanish mid-copy): retry.
copy_data() { rm -rf "$TMP/data"; if [ "$(uname)" = Darwin ]; then cp -c -R "$SOURCE_DATA" "$TMP/data"; else cp -R --reflink=auto "$SOURCE_DATA" "$TMP/data"; fi; }
copy_data 2>/dev/null || copy_data 2>/dev/null || copy_data || die "could not copy $SOURCE_DATA"
rm -f "$TMP/data/.server-lock" "$TMP/data/.server-lock.recovery"  # the copy belongs to no running server
# The demo shows the bundled starters (examples/starters, the source of truth), not whatever the data dir holds:
# load them into the copy as their source projects, replacing any local edits. snapshot-demo.mjs fails if a demo
# project still differs from its bundle.
node scripts/import-starters.mjs --data-dir "$TMP/data" --force >"$TMP/import.log" 2>&1 || { cat "$TMP/import.log"; die "starters:import into the data copy failed"; }
# Clean environment: no credentials, no paid execution, no phone/Blender/headless, no local ComfyUI.
env -i HOME="$HOME" PATH="$PATH" PORT="$port" PREVIS_DATA_DIR="$TMP/data" PREVIS_COMFY_URL=http://127.0.0.1:9 \
  node server/previs/server.mjs >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$port/api/director/projects" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$port/api/director/projects" >/dev/null || { cat "$TMP/server.log"; die "server did not start"; }
DEMO_MEDIA_MB=${DEMO_MEDIA_MB:-400} PREVIS_URL="http://127.0.0.1:$port" PREVIS_DATA="$TMP/data" pnpm run demo:build >"$TMP/demo.log" 2>&1 || { tail -30 "$TMP/demo.log"; die "demo:build failed"; }
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
grep 'demo snapshot:' "$TMP/demo.log" || die "no snapshot summary in demo:build output"
! grep -q '^warning:' "$TMP/demo.log" || { grep '^warning:' "$TMP/demo.log"; die "snapshot incomplete"; }
! grep -q 'skipped over budget' "$TMP/demo.log" || die "demo media over budget (the demo would show missing images): raise DEMO_MEDIA_MB"
scan_dir dist-demo

say "demo: dist-demo → $DEMO_TAG release → Pages"
# No AppleDouble (._*) files or extended attributes in the archive.
tar_flags=(); [ "$(uname)" = Darwin ] && tar_flags=(--no-mac-metadata --no-xattrs)
COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -czf "$TMP/demo-site.tar.gz" -C dist-demo .
DEMO_SHA256=$(shasum -a 256 "$TMP/demo-site.tar.gz" | cut -d' ' -f1)
echo "demo-site.tar.gz: $(du -h "$TMP/demo-site.tar.gz" | cut -f1 | tr -d ' '), $(find dist-demo -type f | wc -l | tr -d ' ') files, sha256 $DEMO_SHA256"

if [ "$DRY_RUN" = 1 ]; then say "DRY_RUN done: main $MAIN_SHA, demo $DEMO_SHA256 (nothing pushed, uploaded or deployed)"; exit 0; fi

printf 'The built read-only demo that the GitHub Pages workflow (`.github/workflows/pages.yml`) deploys, from %s. Updated by `scripts/publish-public.sh`.\n\nNot a software release: to try the app, see the [README](https://github.com/%s#quick-start). The launch films are in the [films release](https://github.com/%s/releases/tag/%s).\n' \
  "$SHA" "$SLUG" "$SLUG" "$FILMS_TAG" >"$TMP/demo-notes.md"
if gh release view "$DEMO_TAG" -R "$SLUG" >/dev/null 2>&1; then
  gh release edit "$DEMO_TAG" -R "$SLUG" --notes-file "$TMP/demo-notes.md" >/dev/null
else
  gh release create "$DEMO_TAG" -R "$SLUG" --title "Live demo build" --notes-file "$TMP/demo-notes.md" \
    --prerelease --latest=false --target "$PUBLIC_BRANCH" >/dev/null
fi
gh release upload "$DEMO_TAG" -R "$SLUG" --clobber "$TMP/demo-site.tar.gz"
PUBLIC_REMOTE="$PUBLIC_REMOTE" DEMO_SHA256="$DEMO_SHA256" scripts/publish-pages.sh || die "Pages deploy failed"

# ---------------------------------------------------------------- 4. verify
BUST=$(date +%s)
say "verify: every file in dist-demo is served unchanged"
(cd dist-demo && find . -type f | sed 's#^\./##' | sort) >"$TMP/files"
for attempt in 1 2 3 4; do  # the CDN may serve the previous deploy for a moment
  PAGES_URL="$PAGES_URL" BUST="$BUST$attempt" xargs -P 8 -n 1 sh -c '
    got=$(curl -sf "$PAGES_URL$1?v=$BUST" | shasum -a 256 | cut -d" " -f1)
    [ "$got" = "$(shasum -a 256 "dist-demo/$1" | cut -d" " -f1)" ] || echo "$1"' _ <"$TMP/files" >"$TMP/mismatch"
  [ -s "$TMP/mismatch" ] || break
  cp "$TMP/mismatch" "$TMP/files"; sleep 15
done
[ ! -s "$TMP/mismatch" ] || { head -10 "$TMP/mismatch"; die "$(wc -l <"$TMP/mismatch" | tr -d ' ') files differ on $PAGES_URL"; }
echo "ok  $(find dist-demo -type f | wc -l | tr -d ' ') files match"

status() { curl -sI "$1" | awk 'toupper($1) ~ /^HTTP/ {s=$2} tolower($1)=="content-length:" {l=$2} END {gsub(/\r/,"",l); print s, l}'; }
for name in $FILMS; do
  want=$(gh api "repos/$SLUG/releases/tags/$FILMS_TAG" --jq ".assets[] | select(.name == \"$name\") | .size")
  read -r code len < <(status "$PAGES_URL$name?v=$BUST")
  [ "$code $len" = "200 $want" ] || die "$PAGES_URL$name: got $code / $len bytes, expected 200 / $want (the films release)"
  echo "ok  $name: $len bytes on Pages, same as the $FILMS_TAG release"
done

say "verify: headless Chrome"
PAGES_URL="$PAGES_URL" BUST="$BUST" FILMS="$FILMS" RELEASE_URL="https://github.com/$SLUG/releases/download/$FILMS_TAG/" node --input-type=module -e '
const { chromium } = await import("playwright-core");
const { resolveExecutable, CHROMIUM_ARGS } = await import("./server/previs/headless.mjs");
const base = process.env.PAGES_URL, q = "v=" + process.env.BUST;
const browser = await chromium.launch({ executablePath: resolveExecutable() || undefined, headless: true, args: [...CHROMIUM_ARGS] });
const { projects } = await (await fetch(base + "demo-data/projects.json?" + q)).json();
let failed = false;
// Console errors (incl. failed loads) and page errors fail the check. The automatic browser
// /favicon.ico request at the host root is outside the app and ignored. One retry for CDN blips.
async function visit(url, check, attempt = 1) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", m => { if (m.type() === "error" && !/\/favicon\.ico$/.test(m.location().url || "")) errors.push(m.text() + " " + (m.location().url || "").replace(base, "")); });
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const value = await page.evaluate(check);
  await page.close();
  return errors.length && attempt < 2 ? visit(url, check, attempt + 1) : { value, errors };
}
const report = (label, ok, r) => { console.log(`${ok && !r.errors.length ? "ok  " : "FAIL"} ${label}${r.errors.length ? ` — ${r.errors.length} console errors` : ""}`); for (const e of r.errors.slice(0, 8)) console.log("       " + e.slice(0, 200)); if (!ok || r.errors.length) failed = true; };
const names = projects.map(p => p.title.replace(/^Starter · /, ""));
const home = await visit(base + "?" + q, `(${JSON.stringify(names)}).filter(t => document.body.innerText.includes(t)).length`);
report(`home lists ${home.value}/${names.length} starters`, home.value === names.length, home);
for (const p of projects) {
  const r = await visit(base + "director.html?project=" + p.id + "&" + q, `({ canvas: !!document.querySelector("canvas"), title: document.title })`);
  const ok = r.value.canvas && r.value.title.includes(p.title);
  report(`director.html loads ${p.title} (${r.value.canvas ? "3D viewport" : "no viewport"})`, ok, r);
}
const page = await browser.newPage();
await page.goto(base + "?" + q);
// Each film must play (not just load metadata) from the release, as the README links it, and from the demo site.
const play = src => page.evaluate(src => new Promise(ok => { const v = document.createElement("video"); v.muted = true;
  const done = r => { clearTimeout(t); v.remove(); ok(r); }, t = setTimeout(() => done(null), 30000);
  v.ontimeupdate = () => v.currentTime > 0.5 && done({ duration: v.duration, size: v.videoWidth + "x" + v.videoHeight });
  v.onerror = () => done(null); v.src = src; document.body.append(v); v.play().catch(() => done(null)); }), src);
const urls = process.env.FILMS.split(" ").flatMap(n => [process.env.RELEASE_URL + n, base + n + "?" + q]);
for (const url of urls) {
  const film = await play(url);
  console.log(`${film ? "ok  " : "FAIL"} plays ${url.split("?")[0]}${film ? ": " + film.size + ", " + film.duration.toFixed(1) + " s" : ""}`);
  if (!film) failed = true;
}
await browser.close();
if (failed) process.exit(1);
' || die "browser check failed"

say "published"
cat <<EOF
source   $SHA ($BRANCH)
main     $MAIN_SHA  https://github.com/$SLUG/commit/$MAIN_SHA
demo     $PAGES_URL  (demo-site.tar.gz $DEMO_SHA256)
films    https://github.com/$SLUG/releases/tag/$FILMS_TAG  (also served as ${PAGES_URL}launch-film*.mp4)
EOF
