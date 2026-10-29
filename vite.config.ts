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

export default defineConfig({
  plugins: [vcamRelay()],
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
        main: "index.html",
        previs: "previs.html",
        comfy: "comfy.html",
        generation: "generation.html",
        transfer: "transfer.html",
        setup: "setup.html",
        phone: "phone.html",
        phoneSolo: "phone-solo.html",
      },
    },
  },
});
