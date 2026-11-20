import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Test configuration (`npm test` = `vitest run`). The suites live next to the
 * code they test; see tests/README.md.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // unit, property and fixture suites plus src/integration (real bundled data); nothing else is collected
      include: ["src/**/*.test.ts"],
      // no DOM: everything under test is plain data code (WebGL is covered by the browser smoke test)
      environment: "node",
      // the defaults (5 s per test, 10 s per hook) are tight for the brute-force references and for
      // loading the 26 MB demo matrix on a slow CI runner; a whole run normally takes a few seconds
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
