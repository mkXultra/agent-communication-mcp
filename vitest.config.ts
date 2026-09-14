import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,  // Increased from 10s to 20s for general tests
    hookTimeout: 15000,  // Increased from 10s to 15s for hooks
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90
      }
    },
    // Override timeouts for specific test types
    overrides: [
      {
        test: {
          testTimeout: 30000,  // 30s for performance tests
        },
        include: ['**/performance/**/*.test.ts']
      },
      {
        test: {
          testTimeout: 25000,  // 25s for e2e tests
          hookTimeout: 20000,
        },
        include: ['**/e2e/**/*.test.ts']
      },
      {
        test: {
          testTimeout: 25000,  // 25s for edge case stress tests
        },
        include: ['**/MCPToolEdgeCases.test.ts']
      },
      {
        test: {
          testTimeout: 30000,  // 30s for concurrency tests (increased for CI)
        },
        include: ['**/concurrency/**/*.test.ts', '**/file-locking/**/*.test.ts', '**/FileLock.test.ts']
      }
    ],
    // `include` / `exclude` live in the projects only: with `extends: true` arrays from the root are concatenated.
    //
    // The cloud projects and the file-mode projects never run at the same time (`sequence.groupOrder`: cloud-compat,
    // then cloud, then file and file-concurrency).
    // The existing tests use timing thresholds (e.g. a wait released within 2 s) and fixed data directories, and the
    // cloud tests put real load on agora (bulk sends, capacity limits, extra wrangler dev instances, stdio servers).
    // The cloud projects run their files one after another in a single fork, so a timing-sensitive test never shares
    // the machine with another file of this run. The agora instances are started by the globalSetup before any test.
    projects: [
      {
        // Cloud mode (AGENT_COMM_TOKEN) against agora started with `wrangler dev` (AGORA_DIR, default ../agora), which
        // AGENT_COMM_API_URL points at: the existing e2e and integration tests, unchanged, in cloud mode.
        extends: true,
        test: {
          name: 'cloud-compat',
          include: ['tests/e2e/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          // mcp-server.test.ts needs a prebuilt dist/ and E2E_TESTS=true (skipped in both modes by
          // default); tests/cloud/stdio-server.test.ts covers the stdio server in cloud mode instead.
          exclude: ['node_modules', 'dist', 'tests/e2e/mcp-server.test.ts'],
          globalSetup: ['tests/cloud/harness/globalSetup.ts'],
          setupFiles: ['tests/cloud/harness/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 0 },
        },
      },
      {
        // Cloud mode only: WebSocket, long polling fallback, error mapping, tool contracts, stdio, harness.
        extends: true,
        test: {
          name: 'cloud',
          include: ['tests/cloud/**/*.test.ts'],
          exclude: ['node_modules', 'dist'],
          globalSetup: ['tests/cloud/harness/globalSetup.ts'],
          setupFiles: ['tests/cloud/harness/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      },
      {
        // File mode (AGENT_COMM_DATA_DIR): the existing suite, unchanged.
        extends: true,
        test: {
          name: 'file',
          include: ['tests/**/*.test.ts'],
          exclude: ['node_modules', 'dist', 'tests/cloud/**', 'tests/file-concurrency/**'],
          setupFiles: ['tests/setup/file-mode.ts'],
          sequence: { groupOrder: 2 },
        },
      },
      {
        // File mode: the atomic JSON writes of src/utils/atomicFile.ts (concurrent readers, and the file attributes,
        // links and error handling they keep). A project of its own so that `--project file` stays the existing suite.
        extends: true,
        test: {
          name: 'file-concurrency',
          include: ['tests/file-concurrency/**/*.test.ts'],
          exclude: ['node_modules', 'dist'],
          setupFiles: ['tests/setup/file-mode.ts'],
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
