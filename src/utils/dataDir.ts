import { homedir } from 'os';
import { join } from 'path';
import { existsSync, accessSync, constants } from 'fs';

export const DEFAULT_HOME_DATA_DIR = join(homedir(), '.agent-communication-mcp');
export const LEGACY_DATA_DIR = './data';

/**
 * Get the data directory with the following priority:
 * 1. Environment variable AGENT_COMM_DATA_DIR (highest priority)
 * 2. Legacy ./data directory if it exists and is writable (backward compatibility)
 * 3. Home directory ~/.agent-communication-mcp (new default)
 */
export function getDataDirectory(): string {
  // 環境変数が設定されている場合は最優先
  if (process.env.AGENT_COMM_DATA_DIR) {
    return process.env.AGENT_COMM_DATA_DIR;
  }
  
  // レガシーディレクトリの確認
  if (existsSync(LEGACY_DATA_DIR)) {
    try {
      accessSync(LEGACY_DATA_DIR, constants.W_OK);
      console.warn(
        `Warning: Using legacy data directory "${LEGACY_DATA_DIR}". ` +
        `Consider setting AGENT_COMM_DATA_DIR="${DEFAULT_HOME_DATA_DIR}" ` +
        `and migrating your data.`
      );
      return LEGACY_DATA_DIR;
    } catch {
      // 書き込み権限がない場合は新しいデフォルトを使用
    }
  }
  
  return DEFAULT_HOME_DATA_DIR;
}