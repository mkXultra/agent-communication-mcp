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
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
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
    ]
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});