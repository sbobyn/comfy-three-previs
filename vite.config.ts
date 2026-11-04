import { defineConfig, type PluginOption } from "vite";
import { attachRelay } from "./server/relay";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Shown in "Report a problem" diagnostics (src/director-report.ts).
const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
let commit = "";
try { commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}

function vcamRelay(): PluginOption {
  return {
    name: "vcam-relay",
    configureServer(server) {
      if (server.httpServer) attachRelay(server.httpServer);
    },
  };
}

// Static read-only demo (GitHub Pages): load the fetch/media shim before any
// page code. Build with VITE_DEMO=1; see scripts/snapshot-demo.mjs.
function demoShim(): PluginOption {
  return {
    name: "demo-shim",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace(/<script type="module"/, '<script type="module" src="/src/demo-shim.ts"></script>\n    $&'),
    },
  };
}

export default defineConfig({
  plugins: [vcamRelay(), ...(process.env.VITE_DEMO ? [demoShim()] : [])],
  define: { __PREVIS_VERSION__: JSON.stringify(version), __PREVIS_COMMIT__: JSON.stringify(commit) },
  server: {
    // Quick tunnels hand out a random *.trycloudflare.com host, which Vite's
    // host check rejects by default.
    allowedHosts: [".trycloudflare.com"],
  },
  build: {
    manifest: true,
    rollupOptions: {
      input: {
        start: "start.html",
        director: "director.html",
        setup: "setup.html",
        phone: "phone.html",
        render: "render.html",
      },
      output: {
        // three in two chunks (core math/scene graph, then renderer + examples) instead of one 550 kB chunk.
        manualChunks(id) {
          if (id.includes("node_modules/three/build/three.core")) return "three-core";
          if (id.includes("node_modules/three/")) return "three";
        },
      },
    },
  },
});
