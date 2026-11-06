# Product onboarding plan — 2026-11-06

For an independent creator making a short previs/demo, the first useful result is
an edited scene, a playable silent MP4 and an editable ZIP that survives reopening.
Delivery is Git-first source plus a separately identified local review archive;
there is no desktop installer, stable release channel or automatic updater.

Candidate **0.1.0-review.20261106.1**, base `9de3d8c`, has [dated install/export evidence](review-version.md).
Repository version `0.1.0-review.20261106.2` carries the later README/setup changes;
they are not in that frozen package. macOS arm64/Node25.2.1 is verified for setup; other platforms,
minimum Node, providers and complete human UI acceptance remain unqualified.

## Existing work and proposed milestone

Live Linear read on November 6 found four project issues, all Backlog/unassigned,
and **no milestones**. Propose one **DRAFT** milestone, **First useful scene and safe
return**, under the [existing project](https://linear.app/sbobyn/project/video-lab-e5d16e6a9ac6),
without a target date. Its acceptance is a real first session plus a recoverable
return/update path, not public launch or complete feature expansion.

| Order / stream | State and evidence | Existing scope / smallest next action | Acceptance and dependencies |
|---|---|---|---|
| 1. First useful session and feedback | Setup/export contracts **verified**; human acceptance **implemented but unverified** | [STE-3088](https://linear.app/sbobyn/issue/STE-3088/video-lab-clean-baseline-and-hands-on-qualification), updated, not duplicated. Steven follows the version-matched README for a 20–25 minute scene/camera/export session. | Record exact version/browser, time/help, expected/actual result, reload and ZIP result. Existing lead retains raw feedback, deduplicates bugs/guidance/unsupported behavior/features. Steven owns acceptance. |
| 2. Provider/settings experience | Diagnostic/env UI **implemented but unverified** for full user flow; durable provider preference editor **planned** | STE-3088 setup slice. Apply [configuration ownership](setup.md#configuration-ownership) to observed friction before implementation. | Nonsecret settings schema/validation/atomic save, visible overrides, clear restart/apply semantics; no silent reroute or paid dispatch. Lead owns proposal; provider spend remains Steven's separate decision. No keys required for step 1. |
| 3. Persistence/recovery and updates | Scene/media ZIP and restart **verified**; whole-store restore, update and rollback **planned** | STE-3088 persistence slice; use [backup guide](setup.md#backup-and-restore-a-copy) with disposable stores. | Restore matching version, scenes/assets/library/budget/config and representative exports without touching original data. Record browser-only preference limits. Lead owns preparation; data-discard decisions stay with Steven. |
| 4. Masked-edit recovery | **Blocked for use** by known static race and recovery defects | [STE-3092](https://linear.app/sbobyn/issue/STE-3092/qualify-masked-edit-resume-before-merging-draft-pr-1), updated with acceptance-race gate. | Preserve intervening edits; current-state queued/idempotent acceptance; uncertain completed jobs and missing-preview recovery; zero new generation dispatches. Existing lead owns fix proposal; no merge/paid test authorized. Not required for first session. |
| 5. Starter provenance/current examples | **Planned**, exact producer pin incomplete; existing media usable with limits | [STE-3089](https://linear.app/sbobyn/issue/STE-3089/video-lab-verify-pinned-starter-provenance-before-any-rebake), unchanged; related producer contract [STE-3091](https://linear.app/sbobyn/issue/STE-3091/beret-parts-p3-consumer-contract-check-previs-reads-vs-beret-parts). | Source commit, recipe/output hashes and tool versions before any rebake; reconcile 32 total vs 29 library-derived without assuming a defect. Preserve owner and child relationship to STE-3088. |
| 6. Distribution/public page | Local archive **verified** by checksum/content and install; public release **planned** | Later STE-3088 release slice; no separate issue yet. Reconcile exact candidate, README, gallery, release notes and renamed Pages path after feedback. | User chooses version/channel and publication timing. Actual current-brand captures and authorized Pages deployment required before calling public page ready. No native installer required for a Git-first product. |
| Parallel preservation | **Blocked** for destructive cleanup; qualified local backup exists but independent destination/approval unresolved | [STE-3093](https://linear.app/sbobyn/issue/STE-3093/deferred-recovery-work-individually-qualify-before-adoption), unchanged. Preserve all unique refs/copies and shared dependencies. | Existing lead/coordinator coordinate recovery path; Steven decides storage/discard. No directory move/deletion or branch adoption follows from onboarding. |

No new issue or milestone was created. STE-3088 and STE-3092 descriptions were
updated and read back; statuses, assignments, parent relationships and milestone
membership remain unchanged. No evidence supports closing any of the four issues.
Persistent settings and public distribution are distinct possible future tickets,
but do not split them out until feedback makes scope concrete.

## Readiness, conflicts and next decisions

- **Hands-on:** ready for a bounded local review with exclusions; cleanup is not a prerequisite.
- **Release:** not ready for a general/public release claim. Current screenshots are dated,
  Pages not requalified, providers/platforms/update recovery not qualified.
- **User acceptance:** pending Steven's actual session; automated checks do not close it.
- **Audit/cleanup:** prior bounded code/architecture audits delivered findings; fixes and
  preservation disposition remain open. No new full audit was run for this plan.

The Linear project description and Obsidian baseline paragraphs describe November 5
cleanup; “no fresh install/live workflow rerun” is historical and superseded by the
November 6 evidence for the narrow tested paths. They do not mean complete UI or
provider qualification. Original notes remain dated; current receipt links the result.
The generated model table lists source presets/historical prices, not live availability.
Setup's first-copy `.env` command must not overwrite an existing config; the detailed
guide now explains this gap. Renderer construction/recovery proposals remain separate
from measured hardware failures. The Blender environment proposal is also unapplied.

No immediate product decision is needed to start the no-provider session. After
feedback, batch decisions on workflow direction and which provider experiment, if
any, deserves an approved budget. Public release/version policy and any recovery-data
discard remain later explicit choices. Nothing populates the user's install area.
