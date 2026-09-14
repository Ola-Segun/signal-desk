import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * `.mts` rather than `.ts` so Vite's native config loader reads it as ESM.
 * With a `.ts` extension and no `"type": "module"` in package.json it is loaded
 * as CommonJS and warns.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /**
       * `server-only` throws by design when imported outside a Server
       * Component, which is what makes it a useful guard in the app — and what
       * breaks it under the test runner. The package ships `empty.js` for
       * exactly this case (it is what the `react-server` export condition
       * resolves to), so the guard stays real in the build and is a no-op here.
       */
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The deterministic core is what these tests exist for. Coverage of the
    // UI is deliberately not chased — a snapshot of a div proves nothing.
    coverage: {
      include: [
        "src/lib/size/**",
        "src/lib/score/technical.ts",
        "src/lib/route/**",
        "src/lib/market/binance.ts",
      ],
    },
  },
});
