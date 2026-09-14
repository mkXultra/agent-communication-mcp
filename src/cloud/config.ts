// Agent Communication MCP Server - operating mode selection
// docs/cloud-architecture.md §5.1: AGENT_COMM_API_URL + AGENT_COMM_TOKEN selects cloud mode and
// takes precedence over AGENT_COMM_DATA_DIR. Anything else keeps the existing file mode.

import { AppError } from '../errors/index.js';
import { createLogger } from '../utils/logger.js';

export const API_URL_ENV = 'AGENT_COMM_API_URL';
export const TOKEN_ENV = 'AGENT_COMM_TOKEN';

export type OperatingMode = 'file' | 'cloud';

export interface CloudConfig {
  /** Base URL of the cloud API without a trailing slash, e.g. `https://agora.omajinai.work`. */
  apiUrl: string;
  /** User token sent as `Authorization: Bearer <token>`. */
  token: string;
}

const logger = createLogger('agent-communication-mcp:cloud');
let warnedPartialConfig = false;

/**
 * Returns the cloud configuration, or `null` when the server should run in file mode.
 * Throws when AGENT_COMM_API_URL is set together with a token but is not an http(s) URL.
 */
export function resolveCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  const apiUrl = env[API_URL_ENV]?.trim();
  const token = env[TOKEN_ENV]?.trim();

  if (!apiUrl || !token) {
    if ((apiUrl || token) && !warnedPartialConfig) {
      warnedPartialConfig = true;
      const missing = apiUrl ? TOKEN_ENV : API_URL_ENV;
      logger.warn(`Cloud mode needs both ${API_URL_ENV} and ${TOKEN_ENV}; ${missing} is missing, using file mode`);
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new AppError(`${API_URL_ENV} is not a valid URL: ${apiUrl}`, 'INVALID_CONFIGURATION', 500);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(`${API_URL_ENV} must use http or https: ${apiUrl}`, 'INVALID_CONFIGURATION', 500);
  }
  parsed.search = '';
  parsed.hash = '';
  return { apiUrl: parsed.toString().replace(/\/+$/, ''), token };
}

export function getOperatingMode(env: NodeJS.ProcessEnv = process.env): OperatingMode {
  return resolveCloudConfig(env) ? 'cloud' : 'file';
}
