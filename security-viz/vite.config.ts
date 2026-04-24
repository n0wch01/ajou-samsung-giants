import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sentinelControlPlugin } from "./vite-plugin-sentinel";

export default defineConfig({
  plugins: [react(), sentinelControlPlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
