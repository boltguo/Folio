import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  plugins: [
    vue(),
    ui({
      router: false,
      dts: false,
      autoImport: false,
      components: false,
      colorMode: false,
      ui: { colors: { primary: "indigo", neutral: "zinc" } },
      icon: { clientBundle: { scan: true } },
    }),
    cloudflare(),
  ],
  resolve: {
    alias: { "@": new URL("./src/client", import.meta.url).pathname },
  },
});
