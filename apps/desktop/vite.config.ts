import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build. `base: "./"` produces relative asset URLs so the built
// index.html loads correctly from the file:// protocol inside Electron.
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
