import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // Excalidraw checks this at runtime; Vite doesn't define `process.env` on its own.
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: {
    // WKWebView (macOS) and WebKitGTK (Linux) are both WebKit.
    target: "safari15",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Automerge's wasm is inlined as base64; size is fine for a local desktop app.
    chunkSizeWarningLimit: 8000,
  },
});
