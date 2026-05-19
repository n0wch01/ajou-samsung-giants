import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { photoSsotPlugin } from "./vite-plugin-photo";
import { sentinelControlPlugin } from "./vite-plugin-sentinel";

export default defineConfig({
  plugins: [react(), photoSsotPlugin(), sentinelControlPlugin()],
  server: {
    proxy: {
      "/api/sentinel": "http://127.0.0.1:19119",
      "/api/scenario": "http://127.0.0.1:19119",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
