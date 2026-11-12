import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  plugins: [vue(), cloudflare()],
  resolve: {
    alias: { "@": new URL("./src/client", import.meta.url).pathname },
  },
});
