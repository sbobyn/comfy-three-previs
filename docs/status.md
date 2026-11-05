# Video Lab status

Clean baseline with limited verification. This supersedes dated release checkpoints; they remain historical evidence, not current release gates.

Canonical repository: https://github.com/sbobyn/video-lab (one origin).
Local checkout: `~/dev/video-lab`.
Tracking: https://linear.app/sbobyn/project/video-lab-e5d16e6a9ac6

## Cleanup disposition

Branding and single-repository publishing are integrated. Publishing preserves Git history and requires an explicit invocation; cleanup does not deploy Pages or regenerate films.

All 86 recovery copies remain untouched in the private recovery directory. A private local backup includes Git objects/refs, uncommitted files, project data, configuration and evidence; only rebuildable dependency/build directories were excluded. It was verified against source files. This is not an off-device disaster-recovery backup.

Seven dirty recovery copies were individually classified:
- genreliability: helpers already integrated; residual backend/generation/refgen differences deferred.
- mobile: camera/gestures/sheet largely integrated; residual navigation/layout differences deferred.
- operate: superseded early director/camera implementation; unmatched fragments retained, not restored over newer code.
- phone: superseded early phone/director implementation; unmatched fragments retained; hardware qualification deferred.
- principles: unique author/cast/12-principles starter expansion deferred.
- report: reporting mostly integrated; residual home/README/test differences deferred.
- w4: guide mostly integrated; historical media variants and residual guide-test differences retained.

208 file-change occurrences were inventoried; 85 match main exactly. A different older blob is not automatically a desirable patch. Details: STE-3093.

Deferred branch work: quality/Finish (five commits, tip 10a7ec4), brand restrictions (1bb321d), animation principles (5656ed5). Eagle d4eb274 is patch-equivalent to main. Historical branch refs remain under refs/archive/cleanup/ and in the backup. No recovery directories are deleted.

## PR and feature boundaries

Draft PR #1 (30b5ec8) remains unmerged: masked-edit resume rejects uncertain receipts before checking a later completed job; preview encode failures can leave review media unavailable. STE-3092 tracks qualification. Do not describe the complete post-Cloud review/accept journey as qualified.

Archived three-vcam PR #6 has the same head and is superseded by #1. The predecessor is closed; its repository remains archived.

Starter provenance: 32 blockouts, documentation says 29 library-derived; the current manifest lacks a pinned source commit. STE-3089 covers provenance before any rebake; STE-3091 remains a related beret-parts contract task.

## Verification and next milestone

Cleanup validation: pnpm check (typecheck + builds), bash syntax for publishing scripts, git diff --check. Full tests, fresh dependency installation, live UI workflow, phone/gamepad/Blender hardware paths, Cloud execution and Pages deployment are not rerun for cleanup. Earlier branding verification passed 673 tests with five skipped; that is historical evidence, not this commit's full gate.

Next milestone: hands-on starter → arrange → camera → export → compatible workflow handoff → review, using disposable data and existing outputs. New paid generation requires a separate quote/approval.

Known risks: GitHub Pages needs a new /video-lab/ build/deployment; historical screenshots/films still show old branding. Existing PREVIS_* environment variables, file formats, tool identifiers and certificate names are intentionally retained for compatibility. Configure local data paths deliberately; do not merge or relocate live project libraries automatically.
