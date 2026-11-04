#!/usr/bin/env bash
# Publish the launch films as assets of the public repo's `films` release (a prerelease), replacing the previous cut:
#   scripts/publish-films.sh TRAILER_DIR VERSION        e.g. scripts/publish-films.sh .evidence/launch-film/v7 v7.5
# TRAILER_DIR holds trailer-16x9/-1x1/-9x16/-30s-16x9-VERSION.mp4 and BUILD-REPORT-VERSION.md, or the same names
# without the -VERSION suffix; the report must be at least as new as the films. The films never go into git. Asset names stay the same for every version (launch-film.mp4, -1x1, -9x16, -30s), so links to
#   https://github.com/<owner>/<repo>/releases/download/films/launch-film.mp4
# never change; the release notes record VERSION and each file's SHA-256. Then the live demo is redeployed
# (scripts/publish-pages.sh), which serves the same films as <demo>/launch-film*.mp4.
#
#   PUBLIC_REMOTE  remote of the public repo (default public)
#   NO_DEPLOY=1    upload only; the demo keeps its old film copies until the next deploy
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
PUBLIC_REMOTE=${PUBLIC_REMOTE:-public}
TAG=films
die() { printf 'publish-films: %s\n' "$*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: scripts/publish-films.sh TRAILER_DIR VERSION"
TRAILER_DIR=${1%/}; VERSION=$2
S=; [ -f "$TRAILER_DIR/trailer-16x9-$VERSION.mp4" ] && S=-$VERSION
FILES="trailer-16x9$S.mp4:launch-film.mp4 trailer-1x1$S.mp4:launch-film-1x1.mp4 trailer-9x16$S.mp4:launch-film-9x16.mp4 trailer-30s-16x9$S.mp4:launch-film-30s.mp4"
REPORT=$TRAILER_DIR/BUILD-REPORT$S.md
[ -f "$REPORT" ] || die "$REPORT not found"
for pair in $FILES; do
  f=$TRAILER_DIR/${pair%%:*}
  [ -s "$f" ] || die "missing $f"
  [ ! "$f" -nt "$REPORT" ] || die "$f is newer than $REPORT — build still running?"
done

SLUG=$(git remote get-url "$PUBLIC_REMOTE" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
TMP=$(mktemp -d "${TMPDIR:-/tmp}/publish-films.XXXXXX"); trap 'rm -rf "$TMP"' EXIT

# Copies under the published names (APFS clones on macOS, so no extra disk).
uploads=() table=""
for pair in $FILES; do
  src=$TRAILER_DIR/${pair%%:*}; name=${pair#*:}
  cp -c "$src" "$TMP/$name" 2>/dev/null || cp "$src" "$TMP/$name"
  uploads+=("$TMP/$name")
  table+="| \`$name\` | $(wc -c <"$src" | tr -d ' ') | \`$(shasum -a 256 "$src" | cut -d' ' -f1)\` |"$'\n'
done
cat >"$TMP/notes.md" <<EOF
The launch films for [Comfy Previs](https://github.com/$SLUG), trailer **$VERSION**. Not a software release.

They are kept here rather than in git so the repo stays small to clone. Each new cut replaces these files under the same names, so links stay valid.

| File | Bytes | SHA-256 |
|---|---|---|
$table
EOF

if gh release view "$TAG" -R "$SLUG" >/dev/null 2>&1; then
  gh release edit "$TAG" -R "$SLUG" --title "Launch films" --notes-file "$TMP/notes.md" --prerelease >/dev/null
else
  gh release create "$TAG" -R "$SLUG" --title "Launch films" --notes-file "$TMP/notes.md" --prerelease --latest=false \
    --target "$(gh api "repos/$SLUG" --jq .default_branch)" >/dev/null
fi
echo "uploading $VERSION from $TRAILER_DIR to $SLUG release $TAG"
gh release upload "$TAG" -R "$SLUG" --clobber "${uploads[@]}"

# Check what GitHub stored: size and digest of every asset.
for f in "${uploads[@]}"; do
  name=$(basename "$f"); want="$(wc -c <"$f" | tr -d ' ') sha256:$(shasum -a 256 "$f" | cut -d' ' -f1)"
  got=$(gh api "repos/$SLUG/releases/tags/$TAG" --jq ".assets[] | select(.name == \"$name\") | \"\(.size) \(.digest)\"")
  [ "$got" = "$want" ] || die "$name on the release is '$got', expected '$want'"
  echo "ok  $name  https://github.com/$SLUG/releases/download/$TAG/$name"
done

if [ "${NO_DEPLOY:-0}" = 1 ]; then echo "NO_DEPLOY=1: the live demo was not redeployed"; exit 0; fi
if ! gh release view demo-site -R "$SLUG" >/dev/null 2>&1; then
  echo "no demo-site release yet: the next scripts/publish-public.sh deploys the demo with these films"; exit 0
fi
PUBLIC_REMOTE="$PUBLIC_REMOTE" scripts/publish-pages.sh
PAGES_URL=$(gh api "repos/$SLUG/pages" --jq .html_url)
for f in "${uploads[@]}"; do
  name=$(basename "$f"); want=$(wc -c <"$f" | tr -d ' ')
  for _ in $(seq 24); do
    len=$(curl -sI "$PAGES_URL$name?v=$(date +%s)" | awk 'tolower($1)=="content-length:" {gsub(/\r/,"",$2); print $2}')
    [ "$len" = "$want" ] && break; sleep 5
  done
  [ "$len" = "$want" ] || die "$PAGES_URL$name is ${len:-missing}, expected $want bytes"
  echo "ok  $PAGES_URL$name"
done
