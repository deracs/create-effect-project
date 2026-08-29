import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  server: {
    // Must match WEB_ORIGIN in apps/api, which CORS is scoped to.
    port: 3001
  },
  plugins: [tanstackStart(), viteReact()]
})
