import { defineConfig } from "vite";

// On GitHub Actions the site is served from /<repo>/; locally from /.
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];

export default defineConfig({
  base: process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : "/",
  assetsInclude: ["**/*.glsl"],
  server: { port: 5173 },
  build: { target: "es2022", sourcemap: true },
  worker: { format: "es" },
});
