# First use

Start the app with `pnpm start` and open <http://127.0.0.1:5190>. No key is needed to try it.

1. **Open a starter or New scene.** Starters are finished short films: play their videos, change anything, and see how they were made. **New scene** starts an empty stage.
2. **Build.** Place objects in the viewport: drag to move them, right-click or Shift+A to add one. Each object has a Cast Card that says what it is.
3. **Cast.** Give each cast member an image. **Cast images** puts the whole cast on one board.
4. **Shoot.** Look through the shot camera. Frame it, set keys, or fly it with the keyboard, a [gamepad](gamepad.md) or your [phone](director-phone.md).
5. **Generate.** **Make blockout** films the grey 3D blockout on this computer, free. **Generate** then shows a quote for the shot's video; nothing is charged until you approve it.
6. **Cut.** Put the shots in order, pick each shot's take, and **Export film**. Shots with no generated video yet export as their blockout; the film has no sound.

Generation needs a Comfy Cloud key (`COMFY_CLOUD_API_KEY` in `.env`) or a local ComfyUI. Paid Cloud runs also need `PREVIS_ALLOW_PAID=1`. **Setup** in the app, or `pnpm run doctor`, shows what this machine can do now.

The full guide is [director.md](director.md); the in-app **Guide** shows the same steps with examples.
