import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    // dev mode: `npm run dev -w @lazyobserver/web` proxies to the running daemon-side API
    proxy: {
      "/api": "http://127.0.0.1:43180",
      "/export": "http://127.0.0.1:43180",
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
