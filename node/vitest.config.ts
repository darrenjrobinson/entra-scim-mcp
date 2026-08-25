import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Only what ships. Scripts are operator tooling driven by hand against a
      // live tenant, and holding them to a coverage bar would mean either
      // fake tests or a permanently red gate.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/mock/cli.ts"],
      thresholds: {
        // A floor, not a target. Measured at 87.7 / 79.6 / 94.3 / 90.1 when
        // these were set, and parked a couple of points below that: a real
        // regression trips them, ordinary refactoring does not. Treat as a
        // ratchet — raise them as the figures rise, rather than writing tests
        // that exist only to move a number.
        statements: 85,
        branches: 77,
        functions: 92,
        lines: 88,
      },
    },
  },
});
