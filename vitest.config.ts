import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Local relays (test/relay.ts) and timeouts: a busy CI runner needs more than 5 s.
    testTimeout: 15_000
  }
});
