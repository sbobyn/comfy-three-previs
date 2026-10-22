import { defineConfig } from 'vite';
export default defineConfig({ build: { ssr: 'server/relay.ts', outDir: 'dist-server' } });
