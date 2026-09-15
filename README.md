# three-vcam

R&D prototype: use a phone as a virtual camera head — stream device orientation
to a Three.js scene, record it as a take, and eventually drive a GenDirector
camera's rotation while a motion path drives its position.

Status: boilerplate only (spinning cube). No phone transport yet.

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
