// Agent Communication MCP Server - cloud mode entry point
// docs/cloud-architecture.md §5.2: ToolRegistry -> Adapters -> HTTP client -> Cloudflare.

import { CloudApiClient, type CloudApiClientOptions } from './CloudApiClient.js';
import { CloudManagementService } from './CloudManagementService.js';
import { CloudMessagingService } from './CloudMessagingService.js';
import { CloudRoomsService } from './CloudRoomsService.js';
import { CloudWaitService, type CloudWaitServiceOptions } from './CloudWaitService.js';
import { resolveCloudConfig, type CloudConfig } from './config.js';

export interface CloudBackendOptions {
  api?: CloudApiClientOptions;
  wait?: CloudWaitServiceOptions;
}

/** Everything the adapters need in cloud mode, sharing one HTTP client and one WebSocket pool. */
export class CloudBackend {
  readonly api: CloudApiClient;
  readonly waits: CloudWaitService;
  readonly rooms: CloudRoomsService;
  readonly messaging: CloudMessagingService;
  readonly management: CloudManagementService;

  constructor(
    readonly config: CloudConfig,
    options: CloudBackendOptions = {},
  ) {
    this.api = new CloudApiClient(config, options.api);
    this.waits = new CloudWaitService(this.api, options.wait);
    this.rooms = new CloudRoomsService(this.api, this.waits);
    this.messaging = new CloudMessagingService(this.api, this.rooms, this.waits);
    this.management = new CloudManagementService(this.api, this.waits);
  }

  /** Closes the held WebSockets. The backend stays usable and reconnects on the next wait. */
  close(): Promise<void> {
    return this.waits.close();
  }
}

const backends = new Map<string, CloudBackend>();

/**
 * The backend for the cloud configuration in `env`, or `null` in file mode. One backend per API URL and
 * token per process, so the WebSockets are kept for the process lifetime (§5.4) whichever adapter asks.
 */
export function getCloudBackend(env: NodeJS.ProcessEnv = process.env): CloudBackend | null {
  const config = resolveCloudConfig(env);
  if (!config) return null;
  const key = `${config.apiUrl}\u0000${config.token}`;
  let backend = backends.get(key);
  if (!backend) {
    backend = new CloudBackend(config);
    backends.set(key, backend);
  }
  return backend;
}

export { CloudApiClient } from './CloudApiClient.js';
export type { AttachmentDownload, AttachmentUpload } from './CloudApiClient.js';
export { CloudManagementService } from './CloudManagementService.js';
export { CloudMessagingService } from './CloudMessagingService.js';
export type { DownloadAttachmentResult } from './CloudMessagingService.js';
export { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, contentTypeFor } from './attachments.js';
export { CloudRoomsService } from './CloudRoomsService.js';
export { CloudWaitService } from './CloudWaitService.js';
export { API_URL_ENV, DEFAULT_API_URL, TOKEN_ENV, fileModeNotice, getOperatingMode, resolveCloudConfig } from './config.js';
export type { CloudConfig, OperatingMode } from './config.js';
export { CloudTransportError, toAppError, parseApiErrorBody } from './errors.js';
export { cloudFetch } from './http.js';
export type { ApiErrorContext } from './errors.js';
