import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Root is the project root so the `/src/...` module specifiers in the HTML resolve
  // as written. `publicDir: false` because there are no verbatim static assets — and
  // a directory literally named `public` here would be treated as one by Vite.
  root: __dirname,
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared"),
      "@src": resolve(__dirname, "src"),
    },
  },
});
