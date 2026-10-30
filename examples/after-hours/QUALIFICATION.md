# After Hours — retained H3 execution

One real Comfy Cloud execution completed on October 29, 2026 Pacific time (October 30 UTC). The app uploaded the full source video and three original appearance boards, dispatched once, collected only declared node 3, verified media, and retained an agent review. No retry or replacement generation ran.

## Open the retained local demo

These links reference operator-local data, not shipped example media or a default showcase:

- [Scene and sequence](http://127.0.0.1:5230/director.html?project=8dbbb3c4-399f-4ba9-be7e-487f4b150059&view=sequence): choose **Compare**; drag the seam, then choose **Generated** for the entire output.
- [Original H3 output](http://127.0.0.1:5230/assets/aa7d1d92-8354-4933-996c-e0e3981fb226.mp4).
- [Exact source version 2](http://127.0.0.1:5230/assets/818f183b-4f54-4dc5-8b78-427650b5a748.mp4).
- [Comparison, timing/audio disclosure and saved review](http://127.0.0.1:5230/generation.html?shot=54aaca54-f65c-4a7c-a2bb-cf0a6846bd53&asset=818f183b-4f54-4dc5-8b78-427650b5a748&job=a83490ae-5fcd-4947-a50d-bfa2bc868bc2&output=aa7d1d92-8354-4933-996c-e0e3981fb226).

## Exact identity and timing

- App request: `a83490ae-5fcd-4947-a50d-bfa2bc868bc2`.
- Provider job: `6d7a7544-7d83-462c-b754-a888795e9369`.
- Approved fingerprint: `0617c2421b0590e4f3b6b768301abb51a8858aec216f7a6462fab0ce45340598`.
- Source SHA-256: `55585c936738f4d5f46e1c4d0373725829bda0d3b5c6bb6ab9b08845dab68bb8`.
- Output SHA-256: `1ca5dbae0cc6782671b8d1a5f56b910f03e1135995cb6be0a1a3dd7b960c71f9`.
- Model/settings: MiniMax H3 reference-to-video, requested 768P / 16:9 / four seconds, seed 4242, watermark off. Complete source was Video 1; appearance images were car, Ink creator, Yellow creator in that order.
- App acceptance: `2026-10-30T02:25:48.745Z`; app collection completed `2026-10-30T02:31:21.996Z`, about 5 minutes 33 seconds later. These are app lifecycle times, not a measured GPU runtime or provider billing duration.

| Property | Source | Returned original |
| --- | --- | --- |
| Dimensions | 1280×720 | 1344×768 |
| Aspect ratio | 16:9 | 7:4 |
| FPS | 24 | 24 |
| Decoded frames | 96 | 107 |
| Duration | 4.000000 s | 4.458333 s |
| Audio | None | AAC stereo, 32 kHz |

Eleven extra frames, changed resolution/aspect and added audio remain explicit. No trim, retime, stretch, interpolation, audio removal or repeated-frame fit was applied. Real-app comparison reached source 4.000 s / ended and result 4.000 s with both paused. Generated playback exposes the remaining 0.458333 s. Native playback reported zero dropped frames during the check.

## Visual qualification

Agent review, not Steven's creative acceptance: inspected frames 0, 48, 95 and 106 plus the native comparison. The broad close-to-wide camera reveal and late car lift are recognizable, with clear parallax and two consistent Comfy-shirted characters. The opening shirt branding is recognizable; small-scale and pixel-exact logo fidelity are not certified.

Appearance is stylized/toy-like rather than the requested live action. The bridge and skyline/layout are reinterpreted. This run demonstrates full-video-conditioned motion transfer, but does not establish exact camera geometry, landmark fidelity or live-action quality. Audio stream properties were checked; sound was not aurally reviewed. No new local inference or hardware-controller qualification is established.

The agent observations were saved against this exact job/output and restored in the ordinary comparison UI after navigation.

## Cost evidence

The approved allowance was $3 USD with unresolved charges explicitly accepted. The published partner range was $0.7722–$2.4453; neither figure is a settled charge. One authenticated, read-only GET of this exact provider job returned HTTP 200 / completed and no billed-cost or settlement fields. Final per-job model/runtime/account charges remain unknown. No aggregate usage, reservation or balance change was substituted for job-linked billing.

Operator evidence is retained under `.evidence/comfy-after-hours/`: approval, submitted and completed receipts, exact source/reference bindings, native original files, FFprobe result, frame samples, agent review, billing gap and a completed support packet. The pre-submission packet remains preserved separately. A clean installation needs the exported project/media to open this retained comparison.
