import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Generate unique test directory for each test
function getUniqueTestDir(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return path.join(__dirname, `../../test-data-${timestamp}-${random}`);
}

let testDataDir = getUniqueTestDir();

// Test data directory setup
export async function setupTestDataDir(): Promise<string> {
  // Generate new unique directory for this test
  testDataDir = getUniqueTestDir();
  
  try {
    await fs.rm(testDataDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore if doesn't exist
  }
  await fs.mkdir(testDataDir, { recursive: true });
  return testDataDir;
}

export async function cleanupTestDataDir(): Promise<void> {
  try {
    await fs.rm(testDataDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore errors
  }
}

// Mock environment setup
export function setupTestEnv(dataDir?: string): void {
  // Use the current unique test directory
  process.env.AGENT_COMM_DATA_DIR = dataDir || testDataDir;
  process.env.AGENT_COMM_LOCK_TIMEOUT = '5000'; // Increased timeout for concurrent tests
  process.env.AGENT_COMM_MAX_MESSAGES = '100';
  process.env.AGENT_COMM_MAX_ROOMS = '10';
}

// Reset test environment
export function resetTestEnv(): void {
  delete process.env.AGENT_COMM_DATA_DIR;
  delete process.env.AGENT_COMM_LOCK_TIMEOUT;
  delete process.env.AGENT_COMM_MAX_MESSAGES;
  delete process.env.AGENT_COMM_MAX_ROOMS;
}

// Global test hooks
beforeAll(async () => {
  await setupTestDataDir();
  setupTestEnv();
});

afterAll(async () => {
  await cleanupTestDataDir();
  resetTestEnv();
});

beforeEach(async () => {
  // Create new unique data directory before each test
  const newDir = await setupTestDataDir();
  setupTestEnv(newDir);
});

afterEach(async () => {
  // Optional: Keep data for debugging failed tests
  if (process.env.KEEP_TEST_DATA !== 'true') {
    await cleanupTestDataDir();
  }
});