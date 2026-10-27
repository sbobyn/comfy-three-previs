# Phone and Xbox rehearsal

Status: software checks and simulated devices are distinct from physical qualification. The iPhone 14 Pro Max and Xbox One rehearsal is still pending.

The control mapping follows the established Otter / SB Camera Studio behavior:
Game layout = left stick move, right stick aim, RT up, LT down, LB slow (0.3),
RB fast movement (2.5). RC Mode 2 remains an explicit alternative. Phone =
motion aim plus touch move/altitude, or touch-only aim. Physical walking is not
positional tracking. These changes adapt the existing Previs implementation;
no Otter or SBNodes code/runtime is bundled. Their GPL modules were read as
behavior references, not relicensed as MIT. Existing inherited-source notices
and the unresolved distribution decision still apply.

## Desktop

Choose a controller in Camera studio, then Enable controller. Gamepads must
report standard browser mapping. Press a button after USB/Bluetooth connection;
center sticks and release triggers to arm. **A** advances Enable/Arm → Record shot → Stop shot; it never repeats while held. **X** restores the aim from where controls were enabled while retaining position. **B** pauses. One controller identity stays selected;
disconnection never silently adopts another. Escape, Pause, tab/window blur,
replay and export stop device control. Enable again deliberately. Use **Record
shot**, stop, save NEW shot, reopen, replay, then export the saved motion. The
older Advanced flight-path recorder is not a saved Previs shot.

## Local iPhone HTTPS

The main project/generation server stays on 127.0.0.1. An optional separate HTTPS
listener serves only the phone page, its manifest-listed static dependencies,
public CA certificate, and capability-protected phone socket. No project API,
managed assets, keys, Blender tools or generation routes are exposed there.
The phone sees the fixed camera-study set and current subject/camera/lens.

Use an existing appropriate certificate, or create new local files (no global
trust changes, no downloads):

```
node scripts/phone-certificate.mjs .evidence/phone-tls-NEW LAN_IP_OR_HOST
```

The directory must not already exist. Keep both .key files private. Set these
server environment variables, keeping real paths local and untracked:

```
PREVIS_PHONE_HOST=LAN_IP_OR_HOST
PREVIS_PHONE_PORT=5443
PREVIS_PHONE_CERT=/absolute/path/server.crt
PREVIS_PHONE_KEY=/absolute/path/server.key
PREVIS_PHONE_CA=/absolute/path/ca.crt
```

Restart only the owned Previs server with those values. Same Wi-Fi is required;
venue client isolation can prevent direct LAN connections. An IP certificate
needs regeneration if that IP changes. Do not open the project server to LAN
or use a public tunnel as an implicit workaround.

On desktop, Create phone link. Open that private link in iPhone Safari. The
phone owner must install the **public ca.crt** (AirDrop, or `/phone-ca.crt` on
the configured HTTPS host), then explicitly enable its full trust in iOS
Settings → General → About → Certificate Trust Settings. Certificate profile
installation is under General → VPN & Device Management. These are manual
owner actions; the app never installs certificates. Do not share private keys.
Return to the pairing page, choose Phone on the Mac and Enable controller,
then Enable motion + touch on iPhone. The phone Arm/Record/Stop button uses the same persistent shot recorder as the desktop. Grant the motion permission when prompted.
Actual sensor samples, not permission alone, establish motion readiness. In motion mode, absent or stalled samples stop touch movement; choose touch-only explicitly to operate without sensors.
Touch-only is available without motion permission but still needs trusted HTTPS.

The link expires after eight hours, server stop, or Stop pairing. A replacement
link revokes the previous controller. Screen lock/background/disconnect pauses
input; reconnect and explicitly enable on both devices. Recenter preserves the
current desktop framing. Keep both devices awake for a take. The phone
viewfinder currently displays the desktop-confirmed pose, so LAN latency is
visible; no local predictive latency guarantee is claimed.

## Acceptance / limits

Automated checks are separate from physical qualification. Rehearse actual
iPhone 14 Pro Max and Xbox One tonight: connect, neutral arm, all axes/triggers,
slow/fast, recenter, orientation, lens/subject agreement, loss/reconnect, and a
saved/reopened/exported take. Record iOS version, browser, wired/Bluetooth mode,
network and observed latency. Until that passes, label hardware unqualified.
No Cloud generation or GPU inference is needed for these control checks.

## Current software evidence

The repository includes actual-main-loop and actual-phone-script simulations for
socket loss/reconnect, resolved replay pose/lens, A arm/record/stop, held-button
suppression, motion sample loss and permission cancellation. The transport test
uses a real disposable local TLS listener/WebSocket and verifies missing/stale
capabilities, wrong origins, remote viewer refusal, API/asset isolation and
revocation. These are not physical controller, Safari, network or latency tests.
Starting a replacement take now clears the old export selection: save it before
exporting. Existing source assets are not changed.
