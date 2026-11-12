import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.js"],
    exclude: ["**/node_modules/**"],
    // The release-script tests run git in temporary repositories, possibly
    // from inside a git hook, whose GIT_* variables would point git at this
    // repository instead.
    setupFiles: ["test/setup/isolate-git-env.js"],
    // These are integration tests: each runs scripts, git, pnpm and fake CLIs
    // as separate processes, which can take several seconds under load. The
    // limit only catches hangs; tests that depend on timing check their own
    // timestamps.
    testTimeout: 30_000,
  },
});
