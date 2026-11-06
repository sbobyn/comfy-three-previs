# Direct with an agent (MCP)

Start the app, then open **⋯ More → Direct with Claude** to copy a command with your actual Node and checkout paths, or a Claude Desktop configuration. For Claude Code, the command is:

```sh
claude mcp add video-lab -e PREVIS_URL=http://127.0.0.1:5190 -- node /path/to/video-lab/server/previs/agent.mjs
```

Replace `/path/to/video-lab` with your checkout. Other MCP clients can launch the same `node` process with `PREVIS_URL` pointing to the running app.

Try: “Build a two-person conversation in a café. Give me a wide shot, two over-the-shoulders and a close-up. Quote the stills before generating.”

The agent can create projects, edit objects and Cast Cards, set cameras, inspect prompt sections, import Blender shots and quote batches. Tell it your budget: paid tools carry `maxCostUsd` and can execute when the server permits paid work, without another UI confirmation. The server's spending caps still apply. Leave `PREVIS_ALLOW_PAID` off for free editing and quotes.

To make stills and blockouts without the app open in a browser, start the server with `PREVIS_HEADLESS=1`. This needs Google Chrome or Playwright Chromium; set `PREVIS_CHROMIUM` to its executable path on other systems.


[Back to README](../README.md) · [Headless setup](setup.md#optional-headless-capture)
