#!/usr/bin/env bash
# Publish this checkout to the public repo and its GitHub Pages demo, in one go:
#   1. preflight: clean tree, pushed to $SOURCE_REMOTE, `pnpm check && pnpm test`, secret/path scan
#   2. code: the current tree (not history) as one new commit on $PUBLIC_REMOTE/$PUBLIC_BRANCH
#   3. demo: `pnpm run demo:build` against a temporary read-only server on a copy of the data,
#      plus the latest trailer as launch-film*.mp4, as one new commit on $PUBLIC_REMOTE/$PAGES_BRANCH
#   4. verify: Pages build, HTTP checks, headless Chrome loads a starter with no console errors
# Idempotent: a step with nothing new makes no commit. Never force-pushes.
#
#   PUBLIC_REMOTE   remote to publish to (default public)
#   PUBLIC_BRANCH   code branch (default main);  PAGES_BRANCH  demo branch (default gh-pages)
#   SOURCE_REMOTE   HEAD must already be on a branch of this remote (default origin; ALLOW_UNPUSHED=1 skips)
#   SOURCE_DATA     server data dir to snapshot the demo from (default .evidence/dev-data; copied, never written)
#   TRAILER_DIR     trailer folder with trailer-16x9/-1x1/-9x16/-30s-16x9.mp4 + BUILD-REPORT.md
#                   (default: newest .evidence/launch-film/v*/ that has a BUILD-REPORT.md)
#   DEMO_MEDIA_MB   demo media budget (default 400); the publish stops if the snapshot skips any media
#   PAGES_URL       demo URL (default https://<owner>.github.io/<repo>/ from the remote)
#   DEMO_PORT       port for the temporary server (default: first free port from 5320)
#   COMMIT_TRAILER  optional line appended to both publish commit messages
#   DRY_RUN=1       build and commit in temporary worktrees, but push and verify nothing
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
PUBLIC_REMOTE=${PUBLIC_REMOTE:-public}
PUBLIC_BRANCH=${PUBLIC_BRANCH:-main}
PAGES_BRANCH=${PAGES_BRANCH:-gh-pages}
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
  for wt in "$TMP/main" "$TMP/pages"; do [ -d "$wt" ] && git worktree remove --force "$wt" 2>/dev/null || true; done
  git worktree prune
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

TRAILER_FILES="trailer-16x9.mp4:launch-film.mp4 trailer-1x1.mp4:launch-film-1x1.mp4 trailer-9x16.mp4:launch-film-9x16.mp4 trailer-30s-16x9.mp4:launch-film-30s.mp4"
if [ -z "${TRAILER_DIR:-}" ]; then
  for d in $(ls -d .evidence/launch-film/v[0-9]*/ 2>/dev/null | sed 's#/$##' | grep -E '/v[0-9]+$' | sort -V -r); do
    [ -f "$d/BUILD-REPORT.md" ] && { TRAILER_DIR=$d; break; }
  done
fi
[ -n "${TRAILER_DIR:-}" ] && [ -f "$TRAILER_DIR/BUILD-REPORT.md" ] || die "no trailer folder with a BUILD-REPORT.md (set TRAILER_DIR)"
TRAILER_DIR=${TRAILER_DIR%/}
for pair in $TRAILER_FILES; do
  f=$TRAILER_DIR/${pair%%:*}
  [ -s "$f" ] || die "missing $f"
  [ "$(wc -c <"$f")" -lt 95000000 ] || die "$f is over GitHub's file size limit"
done
[ -z "$(find "$TRAILER_DIR" -name 'trailer-*.mp4' -newer "$TRAILER_DIR/BUILD-REPORT.md")" ] \
  || die "$TRAILER_DIR has trailers newer than its BUILD-REPORT.md — build still running?"
echo "trailer: $TRAILER_DIR"

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

git fetch -q "$PUBLIC_REMOTE"
push() { # $1 = worktree, $2 = branch
  if [ "$DRY_RUN" = 1 ]; then echo "DRY_RUN: would push $(git -C "$1" rev-parse --short HEAD) to $PUBLIC_REMOTE/$2"; return; fi
  git -C "$1" push "$PUBLIC_REMOTE" "HEAD:refs/heads/$2"
}
message() { printf '%s\n\n%s\n' "$1" "$2"; [ -z "$COMMIT_TRAILER" ] || printf '\n%s\n' "$COMMIT_TRAILER"; }

# ---------------------------------------------------------------- 2. public code
say "code: $SHORT → $PUBLIC_REMOTE/$PUBLIC_BRANCH"
git worktree add -q --detach "$TMP/main" "$PUBLIC_REMOTE/$PUBLIC_BRANCH"
git -C "$TMP/main" rm -rq --ignore-unmatch .
git archive "$SHA" | tar -x -C "$TMP/main"
git -C "$TMP/main" add -A -f .
if ! grep -qs export-ignore .gitattributes && [ "$(git -C "$TMP/main" write-tree)" != "$(git rev-parse "$SHA^{tree}")" ]; then
  die "exported tree differs from the source tree"
fi
if git -C "$TMP/main" diff --cached --quiet; then
  echo "public $PUBLIC_BRANCH already has this tree — nothing to commit"
else
  git -C "$TMP/main" diff --cached --shortstat
  git -C "$TMP/main" commit -q -m "$(message "Publish $SHORT" "Snapshot of the current tree at $SHA ($BRANCH). History is not published.")"
  push "$TMP/main" "$PUBLIC_BRANCH"
fi
MAIN_SHA=$(git -C "$TMP/main" rev-parse HEAD)

# ---------------------------------------------------------------- 3. demo
[ -d "$SOURCE_DATA" ] || die "SOURCE_DATA $SOURCE_DATA not found"
port=${DEMO_PORT:-5320}
if [ -z "${DEMO_PORT:-}" ]; then while (: <"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do port=$((port + 1)); done; fi
say "demo: read-only server on :$port (copy of $SOURCE_DATA)"
# A live server may be writing to SOURCE_DATA (temp files vanish mid-copy): retry.
copy_data() { rm -rf "$TMP/data"; if [ "$(uname)" = Darwin ]; then cp -c -R "$SOURCE_DATA" "$TMP/data"; else cp -R --reflink=auto "$SOURCE_DATA" "$TMP/data"; fi; }
copy_data 2>/dev/null || copy_data 2>/dev/null || copy_data || die "could not copy $SOURCE_DATA"
rm -f "$TMP/data/.server-lock" "$TMP/data/.server-lock.recovery"  # the copy belongs to no running server
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

say "demo: dist-demo + $(basename "$TRAILER_DIR") trailer → $PUBLIC_REMOTE/$PAGES_BRANCH"
git worktree add -q --detach "$TMP/pages" "$PUBLIC_REMOTE/$PAGES_BRANCH"
git -C "$TMP/pages" rm -rq --ignore-unmatch .
cp -R dist-demo/. "$TMP/pages/"
touch "$TMP/pages/.nojekyll"
for pair in $TRAILER_FILES; do cp "$TRAILER_DIR/${pair%%:*}" "$TMP/pages/${pair#*:}"; done
git -C "$TMP/pages" add -A -f .
if git -C "$TMP/pages" diff --cached --quiet; then
  echo "public $PAGES_BRANCH already has this demo — nothing to commit"
else
  git -C "$TMP/pages" diff --cached --shortstat
  git -C "$TMP/pages" commit -q -m "$(message "Deploy demo from $SHORT with trailer $(basename "$TRAILER_DIR")" "Read-only demo built from $SHA; launch-film*.mp4 from $(basename "$TRAILER_DIR").")"
  push "$TMP/pages" "$PAGES_BRANCH"
fi
PAGES_SHA=$(git -C "$TMP/pages" rev-parse HEAD)

if [ "$DRY_RUN" = 1 ]; then say "DRY_RUN done: main $MAIN_SHA, pages $PAGES_SHA (nothing pushed)"; exit 0; fi

# ---------------------------------------------------------------- 4. verify
say "verify: Pages build for ${PAGES_SHA:0:7}"
build=
for _ in $(seq 120); do
  build=$(gh api "repos/$SLUG/pages/builds/latest" --jq '.status + " " + .commit' 2>/dev/null || true)
  [ "$build" = "built $PAGES_SHA" ] && break
  case $build in errored*) die "Pages build errored: $build";; esac
  sleep 5
done
[ "$build" = "built $PAGES_SHA" ] || die "Pages build not done after 10 min (latest: $build)"
echo "pages build: built ${PAGES_SHA:0:7}"

status() { curl -sI "$1" | awk 'toupper($1) ~ /^HTTP/ {s=$2} tolower($1)=="content-length:" {l=$2} END {gsub(/\r/,"",l); print s, l}'; }
read -r code _ < <(status "${PAGES_URL}?v=$PAGES_SHA"); echo "index: $code"; [ "$code" = 200 ] || die "demo index returned $code"
for pair in $TRAILER_FILES; do
  name=${pair#*:}; want=$(wc -c <"$TRAILER_DIR/${pair%%:*}" | tr -d ' ')
  for _ in $(seq 24); do read -r code len < <(status "$PAGES_URL$name?v=$PAGES_SHA"); [ "$code $len" = "200 $want" ] && break; sleep 5; done
  [ "$code $len" = "200 $want" ] || die "$name: got $code / $len bytes, expected 200 / $want"
  read -r pcode plen < <(status "$PAGES_URL$name")
  echo "$name: 200, $len bytes (uncached URL: $pcode, $plen bytes$([ "$plen" = "$want" ] || echo ' — CDN still refreshing'))"
done

say "verify: headless Chrome"
PAGES_URL="$PAGES_URL" BUST="$PAGES_SHA" node --input-type=module -e '
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
const film = await page.evaluate(src => new Promise(ok => { const v = document.createElement("video"); v.muted = true; v.preload = "metadata";
  v.onloadedmetadata = () => ok({ duration: v.duration, size: v.videoWidth + "x" + v.videoHeight }); v.onerror = () => ok(null); v.src = src; }), base + "launch-film.mp4?" + q);
await browser.close();
console.log(`${film ? "ok  " : "FAIL"} launch-film.mp4 plays: ${film ? film.size + ", " + film.duration.toFixed(1) + " s" : "did not load"}`);
if (failed || !film) process.exit(1);
' || die "browser check failed"

say "published"
cat <<EOF
source   $SHA ($BRANCH)
main     $MAIN_SHA  https://github.com/$SLUG/commit/$MAIN_SHA
gh-pages $PAGES_SHA  trailer $(basename "$TRAILER_DIR")
demo     $PAGES_URL
film     ${PAGES_URL}launch-film.mp4  (also launch-film-1x1.mp4, launch-film-9x16.mp4, launch-film-30s.mp4)
EOF
