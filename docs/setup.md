# Advanced setup and recovery

## Optional headless capture

Interactive **Make blockout** uses the workspace browser. Agent/server capture
needs headless mode. With your own instance stopped, keep your chosen data/port environment
and set `PREVIS_HEADLESS=1` and `PREVIS_HEADLESS_POOL=1` before `pnpm start`.
The macOS resolver looks for existing Playwright Chromium, then Google Chrome;
`PREVIS_CHROMIUM` can select an existing executable. No browser download is automatic.
The shipped headless arguments target ANGLE Metal; other graphics platforms remain
untested. `/api/director/headless` reports the actual renderer after probing.
Verify actual hardware rendering before expensive graphics work; unknown hardware
or SwiftShader/llvmpipe/software rendering is a blocker, not an approved fallback.
Do not reconfigure shared browsers or weaken browser security to work around it.

## Persistent data and updates

Scene edits are saved on the local server. `PREVIS_DATA_DIR` contains multiple
Director scenes under `director/`, media, receipts/jobs and the budget ledger;
`PREVIS_LIBRARY_DIR` holds reusable assets. Defaults are `.previs/` inside the
installation and `<data>/library`. Set `PREVIS_DATA_DIR` to your chosen persistent
folder before launch to keep data outside replaceable source files. Do not run two servers against the same data/library.
Never remove a live lock. Project ZIP export and shared-asset ZIP export are
separate; exporting one scene is not a backup of the entire library or ledger.

To update, deliberately choose an exact new version, stop your own server, preserve
your current configuration and copy your data/library to a separate backup while
stopped. Install the new version in a **different** folder, run its documented
install/build/check commands, and first test against a **copy** of your data.
There is no qualified migration/rollback guarantee; do not expose your only good
project copy to an unreviewed version. Only reuse the original data after accepting
the result. Retain the old install and pre-update data together for rollback.
For the frozen review archive, do not overwrite it or treat it as a Git checkout;
choose a separate exact-version archive when updating. `.env` is private configuration, not part of the source archive.


## Configuration ownership

Current implementation: Setup reports tool/configuration presence and local service
reachability, shows the active project folder and explains `.env`; it is not a
persistent provider-settings editor. “Ready” is not model compatibility or device
qualification. A connection check does not dispatch generation.

| Kind | Current home / behavior |
|---|---|
| API keys | Private ignored `.env` or process environment; never browser settings or project documents. |
| Port, data/library roots, executable paths | Bootstrap environment; restart required. Changing a root selects a different store; it does not move old data. |
| Provider endpoint, paid permission, budget policy | Environment today; restart required. No durable UI editor yet. Shell values override `.env`. |
| Theme, panels, view preferences | Browser localStorage; browser/profile/origin-specific. A port change can reset the visible preferences without losing server projects. |
| Model, seed, authored inputs, chosen take | Project/run records; changing future defaults must not rewrite existing job inputs. |
| Exports | Server assets and browser downloads; check your browser's destination. No persistent output-folder picker is claimed. |

Do not copy over an existing `.env`. The current Setup copy-command is intended
for first use only; preserve existing values when configuring an installed copy.
Keep `pnpm start` unchanged when adding credentials or changing providers; restart
only your own instance. Paid permission remains off unless explicitly enabled.

### Planned settings improvement (not implemented)

A small versioned nonsecret record at `<PREVIS_DATA_DIR>/settings.json` could hold
normal provider/address and output preferences, using existing atomic-write and
revision/conflict patterns. Proposed precedence: explicit environment override →
saved setting → default, with overrides visible/read-only in Setup. Validate schema,
URLs and paths; absent means default, invalid values fail visibly, and blank must
have a defined per-field meaning rather than enabling a provider. Save atomically
on explicit Apply; report conflict/failure without discarding edits. Connection
changes affect future jobs only; accepted/uncertain work retains original bindings.
Secrets, data-root bootstrap and existing paid-policy gates remain process-side.
No migration or implementation is authorized by this documentation proposal alone.

## Backup and restore a copy

1. Stop your own writer gracefully. Record the install version and active data,
   library and optional `PREVIS_BUDGET_DIR` paths from your configuration.
2. Copy the complete data directory, any separately configured library/budget
   directory and private configuration into a private backup. Preserve files;
   do not move the originals. These can contain private media and credentials.
3. For a portable scene, use `.previs.zip`; export shared assets separately as
   `.previs-asset.zip`. MP4 alone is not an editable backup. ZIPs do not include
   every account/job/ledger record or browser preferences.
4. Restore full stores into new directories and start the matching version with
   those paths and a free port. Keep paid execution off. Never share a library
   between simultaneous servers. Do not remove an active lock.
5. Verify project identity, edits, media playback and representative exports.
   Preserve originals until acceptance. ZIP import clears engine handoff bindings;
   recapture when required. Browser theme/layout preferences are separate and may
   need to be chosen again.

Fresh-install scene ZIP/reopen evidence exists in [review-version.md](review-version.md).
A complete external-store backup/restore and upgrade/rollback drill remains untested.

## Git update exceptions

The ordinary update commands are in the [README](../README.md#updates). If Git reports
local changes or conflicts, stop and preserve them; do not reset, clean, force or
blindly stash. Identify the intended branch/version before reconciling. Do not run
those commands in the immutable review archive. For rollback, use the matching
old application and pre-update data copy; older code is not guaranteed to read data
written by a newer version. No automatic updater or supported migration window exists.
