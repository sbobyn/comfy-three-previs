# three-vcam

R&D prototype: use a phone as a virtual camera head — stream device orientation
to a Three.js scene, record it as a take, and eventually drive a GenDirector
camera's rotation while a motion path drives its position.

Status: orientation streams from an iPhone to the desktop scene. No smoothing or
take recording yet.

## Measured — 2026-09-15, iPhone over a cloudflared quick tunnel

| | |
|---|---|
| rate | 60 Hz (iOS `deviceorientation` cap) |
| latency | 12.3 ms (echo-ping RTT/2) |
| jitter | 1.0 – 2.9 ms |
| drift | 0.3° over 60 s, phone stationary |

The tunnel is in that path — traffic reaches the phone via a Cloudflare edge and
back — so this is a pessimistic figure; a direct LAN link would be lower.

## Commands

```bash
pnpm install
pnpm dev        # http://127.0.0.1:5187
pnpm check      # typecheck + build
```

## Design notes

- **Relative orientation + re-zero**, not absolute/compass. iOS `alpha` is not
  true north and magnetometer yaw drifts; a re-zero control makes whatever
  direction the operator is comfortable holding become scene-forward.
- **Secure context is required** for `DeviceOrientationEvent` on the phone, so
  the phone page cannot be served over plain LAN HTTP. For prototyping, tunnel
  the dev server (e.g. `cloudflared tunnel --url http://127.0.0.1:5187`) rather
  than installing a local CA on the device.
- Success bar to measure before trusting any of this: glass-to-glass latency,
  jitter at rest, and yaw drift over 60s.
