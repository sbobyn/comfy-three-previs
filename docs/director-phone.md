# Director: aim the shot camera with your phone

The phone streams its orientation to the Director; its buttons re-zero, set the
lens and press Record. Transport is the existing phone relay (`/vcam`) and the
optional HTTPS LAN listener (`server/previs/phone-lan.mjs`). Only the phone page,
its static assets, the public CA certificate and a token-protected socket are
reachable from the network — never project APIs or assets.

## One-time setup (Mac)

1. `node scripts/phone-certificate.mjs ./phone-cert YOUR_MAC_LAN_IP`
   (new local files only; changes no trust settings).
2. Set in `.env` and restart video-lab:
   `PREVIS_PHONE_HOST=YOUR_MAC_LAN_IP`, `PREVIS_PHONE_PORT=5443`,
   `PREVIS_PHONE_CERT=…/server.crt`, `PREVIS_PHONE_KEY=…/server.key`,
   `PREVIS_PHONE_CA=…/ca.crt`. Use another port if 5443 is taken.

## Pair (each session)

1. In the Director viewport toolbar click **Phone…** → **Create phone link**.
   The dialog shows two QR codes (certificate, phone link), the link with Copy,
   and live status. Pairing lasts eight hours, until **Stop pairing**, a **New
   link** (which disconnects the old phone) or a server restart. The token lives
   only in the link's `#fragment` and server memory.
2. iPhone, first time only: same Wi‑Fi; scan code 1 in Safari (it warns, the
   certificate is not trusted yet — Show Details → visit this website → Allow),
   or AirDrop `ca.crt`. Settings → General → VPN & Device Management → Install.
   Settings → General → About → Certificate Trust Settings → full trust on.
3. Scan code 2 (reload if the page was open before trusting). Tap **Enable
   motion + touch**, allow Motion & Orientation.
4. Point the phone where the shot should look, tap **Re-zero**.

## Behaviour

- Re-zero is yaw only: pitch and roll stay absolute (gravity), so "level" stays level.
- Smoothing: one-euro deshake (1.2 Hz, β 0.05) then 80 ms inertia (`src/smoothing.ts`).
- No samples for 1 s → "paused" (holds the last aim); 2 s → "silent" (aim released).
- The Director claims the phone on the relay; other open viewers (e.g. the
  camera studio) then no longer steer it, but still receive its samples.
- **Look with phone** (toolbar) is a live preview only: it aims the shot camera
  view from the phone, along the shot's own heading at re-zero, and never saves.

Code: `src/director-aim.ts` (source contract), `src/director-phone.ts` (source,
dialog, preview hook), `src/director-phone-core.ts` (pure logic, tested in
`tests/director-phone.test.mjs`), `src/qr.ts` (QR encoder).
