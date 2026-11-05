#!/usr/bin/env bash
# Redeploy the live demo: run the public repo's "Deploy demo to Pages" workflow (.github/workflows/pages.yml) and
# wait for it. The workflow builds nothing. It takes demo-site.tar.gz from the `demo-site` release (uploaded by
# publish-public.sh) and launch-film*.mp4 from the `films` release (uploaded by publish-films.sh), and deploys them.
# Called by both publish scripts; run it by hand to redeploy without changing anything.
#
#   PUBLIC_REMOTE  remote of the public repo (default origin)
#   DEMO_SHA256    the workflow fails unless demo-site.tar.gz has this SHA-256 (default: deploy whatever is there)
#
# The first run switches the repo's Pages source from a branch to GitHub Actions (`build_type=workflow`). The
# github-pages environment must allow deployments from the default branch.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
PUBLIC_REMOTE=${PUBLIC_REMOTE:-origin}
WORKFLOW=pages.yml
die() { printf 'publish-pages: %s\n' "$*" >&2; exit 1; }

SLUG=$(git remote get-url "$PUBLIC_REMOTE" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
REF=$(gh api "repos/$SLUG" --jq .default_branch)

build_type=$(gh api "repos/$SLUG/pages" --jq .build_type)
if [ "$build_type" != workflow ]; then
  echo "Pages source is '$build_type': switching to GitHub Actions"
  gh api -X PUT "repos/$SLUG/pages" -f build_type=workflow >/dev/null || die "could not switch the Pages source to GitHub Actions"
  [ "$(gh api "repos/$SLUG/pages" --jq .build_type)" = workflow ] || die "Pages source did not switch to GitHub Actions"
fi

since=$(date -u -v-30S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-30 sec' +%Y-%m-%dT%H:%M:%SZ)
out=$(gh workflow run "$WORKFLOW" -R "$SLUG" --ref "$REF" -f demo_sha256="${DEMO_SHA256:-}" 2>&1) || { echo "$out" >&2; die "could not start $WORKFLOW"; }
run=$(printf '%s\n' "$out" | grep -oE '/actions/runs/[0-9]+' | head -1 | sed 's#.*/##' || true)
for _ in $(seq 30); do  # older gh does not print the run URL: take the newest dispatch run since we started it
  [ -n "$run" ] && break
  sleep 2
  run=$(gh run list -R "$SLUG" -w "$WORKFLOW" -e workflow_dispatch -L 5 --json databaseId,createdAt \
    --jq "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")
done
[ -n "$run" ] || die "started $WORKFLOW but could not find its run"
echo "workflow run: https://github.com/$SLUG/actions/runs/$run"

state=
for _ in $(seq 180); do
  state=$(gh run view "$run" -R "$SLUG" --json status,conclusion --jq '.status + " " + .conclusion')
  case $state in completed*) break;; esac
  sleep 5
done
[ "$state" = "completed success" ] || { gh run view "$run" -R "$SLUG" --log-failed 2>/dev/null | tail -30 >&2 || true; die "workflow run $run: ${state:-no status} (15 min limit)"; }
echo "deployed: $(gh api "repos/$SLUG/pages" --jq .html_url)"
