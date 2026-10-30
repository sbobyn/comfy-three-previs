import { defineConfig, type PluginOption } from "vite";
import { attachRelay } from "./server/relay";

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
    },
  },
});
