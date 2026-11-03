# scripts

Operator commands. None of them prints credential values. Paid or cloud work is named explicitly below.

| Command | What it does |
|---|---|
| `pnpm run doctor` | Checks this machine can run Comfy Previs (`--quick` is what `pnpm start` runs). |
| `pnpm starters:import` | Loads the bundles in `examples/starters` into a data directory as the canonical source projects, ids kept. |
| `pnpm starters:export` | Writes the bundles from the source projects. `--check` verifies the round trip and writes nothing. |
| `node scripts/pipeline/regenerate-starters.mjs` | Regenerates starter looks, sheets, stills and videos through the batch API. Paid when run without `--dry-run`. |
| `pnpm demo:build` | Builds the static demo of the starters' source projects; `snapshot-demo.mjs` reads a running server with GET requests only and fails if a demo project differs from its bundle. |
| `node scripts/home-media.mjs --out <fresh-dir>` | Rebuilds homepage comparisons from bundled takes and their exact source clips, with equal frame counts, frame-zero posters and hashed provenance. No server or paid calls. |
| `node scripts/guide-media.mjs` | Captures the guide's media from the starters on a running server (read-only). |
| `pnpm usage:report`, `pnpm docs:models` | Read-only usage and model tables. |
| `publish-public.sh`, `publish-films.sh`, `publish-pages.sh`, `prepare-after-hours.mjs`, `mobile-check.mjs`, `phone-certificate.mjs` | See the header comment of each script. |

## Starters: which side is the source of truth

The bundles in `examples/starters/<slug>/` (`starter.json` plus `media/`) are the source of truth and are what ships.
The exporter's source projects are derived from them:

```
examples/starters  --starters:import-->  <data-dir>/director/<starterSourceId(slug)>/
                   <--starters:export--  (edit, regenerate and accept media here)
                   starters:export --check  =  export into a scratch copy, fail if any file would differ
```

- **Never export from an old dev project** (the pre-2026-10-31 projects listed as `legacyId` in `scripts/export-starters.mjs`):
  they hold the old blocking and an export would undo the blockout pass and the media regeneration.
- **Regenerating media:** import, run `scripts/pipeline/regenerate-starters.mjs` against the source projects (it targets
  them by default), accept results in the app, then `pnpm starters:export` and `pnpm starters:export --check`.
- **Signatures:** import and export keep ids, so signatures in the bundle stay valid unchanged. Only a user's copy
  from the Starters row renews ids, and then signatures that match the snapshot's blocking are rewritten to the copy's.
- **Guard:** `tests/starters-roundtrip.test.mjs` runs import and `--check` against the committed bundles in `pnpm test`.

Details and the bundle format: `examples/starters/README.md`.
