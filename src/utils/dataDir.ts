import { homedir } from 'os';
import { join } from 'path';
import { existsSync, accessSync, constants } from 'fs';

export const DEFAULT_HOME_DATA_DIR = join(homedir(), '.agent-communication-mcp');
export const LEGACY_DATA_DIR = './data';

/**
 * Get the data directory with the following priority:
 * 1. Environment variable AGENT_COMM_DATA_DIR (highest priority)
 * 2. Home directory ~/.agent-communication-mcp (new default)
 */
export function getDataDirectory(): string {
  // 環境変数が設定されている場合は最優先
  if (process.env.AGENT_COMM_DATA_DIR) {
    return process.env.AGENT_COMM_DATA_DIR;
  }
  
  return DEFAULT_HOME_DATA_DIR;
}
