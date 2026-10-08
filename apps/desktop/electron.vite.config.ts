import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
    },
  },
  renderer: {
    plugins: [react()],
  },
});
