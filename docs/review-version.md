# Review versions

## Repository follow-up: 0.1.0-review.20261106.2

This revision carries the streamlined README, linked setup/provider/recovery guides,
onboarding plan and model-table generator destination. It follows the frozen local
archive below; no new downloadable release or runtime feature is implied.

Verification for this follow-up, 2026-11-06: `pnpm check` passed in the disposable
verification copy with existing locked dependencies; model-table consistency and
its focused test passed; local Markdown links/anchors and diff whitespace passed.
No fresh install, full-suite, browser, provider or graphics run was repeated.

## Frozen local archive: 0.1.0-review.20261106.1

Prepared 2026-11-06 from `main` at `9de3d8c83f3c0b465e7709e525e52de7163ee42f`.
That archive is an **uncommitted local source snapshot**, not a Git tag, pushed branch or
public release. The archive checksum and per-file source manifest identify the
exact delivered bytes. `package.json` carries the review version so built app
reports distinguish it from 0.1.0. Archives have no Git checkout; an empty commit
field in app diagnostics is expected. Use this version label and archive checksum.

## Included and held work

Included: baseline runtime, bundled media, maintained architecture/repo map in
`docs/status.md`, release ownership instructions, corrected setup/provider/data/
update instructions, hands-on guide and this verification record. No functional
runtime changes or dependency version changes are included.

Held outside the package: draft masked-edit PR #1 (`30b5ec8`), quality/Finish
(`10a7ec4`), brand restrictions (`1bb321d`), animation principles (`5656ed5`),
94 archived refs, all recovery directories and private preservation material.
Their unique work is retained. No branch was merged, pruned or discarded.
The existing masked-edit acceptance race and recovery blockers remain unresolved:
do not use masked editing in this review. Starter producer provenance remains
incomplete (STE-3089); no starters were regenerated or source media replaced.

## Verification

Fresh-install verification on **2026-11-06, 21:20–21:24 UTC**, macOS arm64,
Node 25.2.1, pnpm 10.18.0, FFmpeg/FFprobe 8.0:

- Source-only extraction with no `.git`, `.env`, `node_modules`, build output or user data.
- `pnpm install --frozen-lockfile` with an isolated `--store-dir`: **30 downloaded,
  zero reused**, optional playwright-core installed, lockfile unchanged.
- `pnpm check`: typecheck and both Vite builds **passed**.
- `pnpm run doctor` and `pnpm start`: **passed** with a new disposable data/library,
  port 5211, paid off, headless off, no inherited provider credentials.
- HTTP home and all **nine** starter listings passed. Created a Mountain Trail copy,
  reread it, exported its existing selected clip as silent H264 **1280×720, 24 fps,
  113 frames / 4.708 seconds**, and decoded the entire MP4 with FFmpeg successfully.
  This is real encoding of bundled media, not new graphics capture or AI generation.
- Exported project ZIP; stopped only the test server gracefully; reopened saved state
  and imported ZIP into a second disposable directory. All **six media hashes** matched.
- `node --test tests/project.test.mjs tests/project-files.test.mjs`: **6 passed,
  0 failed**. Those tests include synthetic media bytes and simulated job results;
  they establish persistence contracts, not video quality or provider success.
- No browser was launched for this install test, and no graphics device was newly
  exercised. No shared session, existing project data or personal install folder changed.
- Full suite not run for these documentation/version changes. Exact minimum runtime,
  clean OS prerequisites installation and human UI steps remain untested.

Final source archive includes `SOURCE-MANIFEST.sha256` and has an external SHA-256
sidecar. Only documentation verification results were finalized after these checks;
package/runtime/dependency bytes are the same as the tested extraction.
No paid generation, private uploads or publication are authorized by this package.

Prior evidence, reused rather than represented as a new install test: on 2026-11-06,
source baseline `9de3d8c` captured 72 frames at 640×360/24fps (3 seconds) through
the production headless path on **Apple M4 Max / ANGLE Metal**, exported silent H264
at 1280×720 (upscaled, not native 720p capture), passed complete FFmpeg decoding and
browser playback, and preserved scene edits/media hashes across ZIP export/import.
This establishes a working local capture-to-film path on that device; it does not
qualify every browser, interactive capture control or platform.

Not qualified: Cloud/local generation and current prices; phone/gamepad/Blender
integration; masked editing; long/complex scenes; full visual UI acceptance;
Windows/Linux; minimum-supported Node version; real user data migrations/rollback;
Pages redeployment. No full suite is required for documentation/version-only work;
focused persistence tests and the project typecheck/build gate are the checks here.

The [architecture/source map](status.md#maintained-architecture-and-repo-map) and
[workflow guide](first-use.md) describe observed boundaries and known gaps. November
release direction remains draft until Steven reviews actual use.
