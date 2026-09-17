// Agent Communication MCP Server - operating mode selection
// docs/cloud-architecture.md §5.1: AGENT_COMM_TOKEN selects cloud mode; AGENT_COMM_API_URL only overrides the
// default API URL. Without a token the server keeps the existing file mode (AGENT_COMM_API_URL alone is ignored).

import { AppError } from '../errors/index.js';

export const API_URL_ENV = 'AGENT_COMM_API_URL';
export const TOKEN_ENV = 'AGENT_COMM_TOKEN';

/** The Agent Communication Cloud (agora) used when AGENT_COMM_API_URL is not set. */
export const DEFAULT_API_URL = 'https://agora.omajinai.work';

export type OperatingMode = 'file' | 'cloud';

export interface CloudConfig {
  /** Base URL of the cloud API without a trailing slash, e.g. `https://agora.omajinai.work`. */
  apiUrl: string;
  /** User token sent as `Authorization: Bearer <token>`. */
  token: string;
}

/**
 * `apiUrl` as the base URL the API paths are appended to: without query, fragment or trailing slash.
 * Throws when it is not an http(s) URL; `source` names the setting it came from in that error.
 */
export function normalizeApiUrl(apiUrl: string, source: string = API_URL_ENV): string {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new AppError(`${source} is not a valid URL: ${apiUrl}`, 'INVALID_CONFIGURATION', 500);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(`${source} must use http or https: ${apiUrl}`, 'INVALID_CONFIGURATION', 500);
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * Returns the cloud configuration, or `null` when the server should run in file mode (no AGENT_COMM_TOKEN).
 * Throws when AGENT_COMM_API_URL is set together with a token but is not an http(s) URL.
 */
export function resolveCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  const token = env[TOKEN_ENV]?.trim();
  if (!token) return null;
  return { apiUrl: normalizeApiUrl(env[API_URL_ENV]?.trim() || DEFAULT_API_URL), token };
}

export function getOperatingMode(env: NodeJS.ProcessEnv = process.env): OperatingMode {
  return resolveCloudConfig(env) ? 'cloud' : 'file';
}

/**
 * The one line the server writes to stderr when it starts in file mode, or `null` in cloud mode.
 * (stdout carries the MCP stdio protocol and must stay clean.)
 */
export function fileModeNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[TOKEN_ENV]?.trim()) return null;
  const ignoredUrl = env[API_URL_ENV]?.trim() ? `（${API_URL_ENV} は無視）` : '';
  return `${TOKEN_ENV} が未設定のためファイルモードで起動${ignoredUrl}`;
}
