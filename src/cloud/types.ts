// Agent Communication MCP Server - Cloud API types
// Shapes from docs/api.yaml (Agent Communication Cloud API 0.6.x, components.schemas).

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface ApiRoom {
  name: string;
  description?: string;
  createdAt: string;
  epoch: string;
  /**
   * Last post time written back by the Room DO, up to a minute late (api 0.6.4, D16). null when the room has no post yet,
   * or was created before api 0.6.4 and has not been accessed since.
   */
  lastMessageAt?: string | null;
  /**
   * Whether the room is deleted automatically after every member has been offline for the server's grace period
   * (api 0.11.0, D22). Servers older than 0.11.0 do not return it: treat a missing value as false.
   */
  ephemeral?: boolean;
}

export interface ApiRoomList {
  rooms: ApiRoom[];
  count: number;
  nextCursor?: string;
}

export interface ApiCreateRoomResult {
  success: boolean;
  roomName: string;
  description?: string;
  createdAt: string;
  epoch: string;
  /** Whether the created room is ephemeral (api 0.11.0, D22); missing on older servers, meaning false. */
  ephemeral?: boolean;
}

export interface ApiAgentProfile {
  role?: string;
  description?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface ApiJoinResult {
  success: boolean;
  roomName: string;
  /** Epoch of the room the member joined (api 0.5.1). */
  epoch: string;
  agentName: string;
  alreadyMember: boolean;
  lastReadSeq?: number;
}

export interface ApiLeaveResult {
  success: boolean;
  roomName: string;
  agentName: string;
}

export interface ApiMember {
  agentName: string;
  profile?: ApiAgentProfile;
  status: 'online' | 'offline';
  connected: boolean;
  waiting?: boolean;
  joinedAt: string;
  lastSeenAt?: string;
  lastReadSeq?: number;
}

export interface ApiMemberList {
  roomName: string;
  /** Epoch of the room the member list belongs to (api 0.5.1). */
  epoch: string;
  members: ApiMember[];
  count: number;
  onlineCount: number;
  connectedCount: number;
}

/** docs/api.yaml `AttachmentInfo` (api 0.6.0, D13). */
export interface ApiAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
}

export interface ApiMessage {
  id: string;
  seq: number;
  clientMessageId?: string;
  agentName: string;
  roomName: string;
  message: string;
  timestamp: string;
  mentions: string[];
  metadata?: Record<string, unknown>;
  /** Omitted or empty when the message has no attachments. */
  attachments?: ApiAttachment[];
}

/** The 201 response of `uploadAttachment`: the upload is not attached to a message yet. */
export interface ApiUploadedAttachment {
  attachmentId: string;
  name: string;
  size: number;
  contentType: string;
  uploader: string;
  createdAt: string;
  /** The upload is deleted when no message has taken it by then. */
  expiresAt: string;
}

export interface ApiSendMessageResult {
  success: boolean;
  messageId: string;
  seq: number;
  roomName: string;
  timestamp: string;
  mentions: string[];
  duplicate: boolean;
}

export interface ApiMessageList {
  roomName: string;
  epoch?: string;
  messages: ApiMessage[];
  count: number;
  hasMore: boolean;
  nextCursor: number;
  latestSeq: number;
  oldestSeq?: number;
  evictedUpToSeq?: number;
  truncated?: boolean;
  timedOut: boolean;
  warning?: string;
  waitingAgents?: string[];
}

export interface ApiGetMessagesQuery {
  since?: number;
  before?: number;
  limit?: number;
  agentName?: string;
  mentionsOnly?: boolean;
  excludeSelf?: boolean;
  wait?: number;
  markRead?: boolean;
}

export interface ApiClearMessagesResult {
  success: boolean;
  roomName: string;
  clearedCount: number;
}

/** docs/api.yaml `AttachmentPurgePreview`: a non-mutating preview of an inclusive attachment range deletion. */
export interface ApiAttachmentPurgePreview {
  dryRun: true;
  roomName: string;
  /** Fixed inclusive upper post position (attachments of that post are all included). */
  throughSeq: number;
  latestSeq: number;
  oldestSeq?: number;
  boundaryMessageExists: boolean;
  boundaryMessageId?: string;
  /** Live attachments at or before `throughSeq` (the deletion targets). */
  attachmentCount: number;
  attachmentBytes: number;
  firstAttachmentSeq?: number;
  lastAttachmentSeq?: number;
  messagesThroughBoundary: number;
  /** Unposted uploads (`message_seq IS NULL`), which are not targets. */
  unpostedAttachmentCount: number;
  unpostedAttachmentBytes: number;
  /**
   * Automatic-retention display rows (`deleted: true`) at or before `throughSeq`. These are no longer in the live
   * attachment list, so they are not live storage and are neither targets nor part of the preview's
   * `attachmentCount` / `attachmentBytes`. This count does not prove that the R2 object is gone or that quota was
   * released: automatic retention records the display row and the cleanup intent before deleting R2, so cleanup for
   * the range can still be pending. A confirmed execute of the same range retries it; the execute result's
   * `deletionStatus` / `pendingAttachments` report whether that physical work has finished. It is a different
   * quantity from the execute result's `deletedAttachmentCount` (the live attachments newly deleted by that request).
   */
  retainedDisplayMetadataCount: number;
  /** Live attachments after the boundary, which are kept. */
  afterBoundaryAttachmentCount: number;
  afterBoundaryAttachmentBytes: number;
  previewedAt: string;
}

/** docs/api.yaml `AttachmentPurgeResult`: the 200 (complete) or 202 (physical cleanup pending) execute response. */
export interface ApiAttachmentPurgeResult {
  success: true;
  roomName: string;
  throughSeq: number;
  deletionStatus: 'complete' | 'pending';
  /** Newly deleted attachment rows in this request (0 on a replay of a completed range). */
  deletedAttachmentCount: number;
  deletedAttachmentBytes: number;
  /**
   * Physical deletions or quota releases still pending for the fixed scope (`0` when complete). Counted
   * conservatively: it may include same-generation cleanup rows from an older schema whose post position cannot be
   * proven, so it can exceed the rows newly deleted by this request but never understates remaining work.
   */
  pendingAttachments: number;
  /** Suggested delay before retrying the same range (milliseconds); present while pending. */
  retryAfterMs?: number;
  executedAt: string;
}

export interface ApiRoomStatus {
  roomName: string;
  epoch?: string;
  messageCount: number;
  agentCount: number;
  onlineCount: number;
  connectedCount: number;
  waitingCount?: number;
  storageBytes?: number;
  /** Attachments in the room, unattached uploads included (api 0.6.0). */
  attachmentCount?: number;
  attachmentBytes?: number;
  oldestSeq?: number;
  latestSeq?: number;
  lastActivityAt?: string;
}

export interface ApiStatus {
  userId: string;
  totalRooms: number;
  totalMessages: number;
  totalAgents: number;
  totalOnline: number;
  totalConnected?: number;
  storageBytes?: number;
  partial: boolean;
  failedRooms?: string[];
  skippedRooms?: string[];
  rooms: ApiRoomStatus[];
}

/* -------------------------------------------------------------------------
 * WebSocket frames (docs/api.yaml ServerFrame / ClientFrame)
 * ---------------------------------------------------------------------- */

export interface ReadyFrame {
  type: 'ready';
  roomName: string;
  epoch: string;
  latestSeq: number;
  lastReadSeq: number;
}

export interface MessageFrame {
  type: 'message';
  message: ApiMessage;
  live: boolean;
}

export interface BacklogEndFrame {
  type: 'backlog_end';
  upToSeq: number;
  truncated?: boolean;
}

export interface PresenceFrame {
  type: 'presence';
  agentName: string;
  event: 'joined' | 'left' | 'idle_timeout' | 'connected' | 'disconnected';
}

export interface WaitingFrame {
  type: 'waiting';
  waitingAgents: string[];
  warning?: string;
}

export interface AckFrame {
  type: 'ack';
  ackFor: 'read' | 'wait_start' | 'wait_end';
  requestId?: string;
  lastReadSeq?: number;
}

export interface ErrorFrame {
  type: 'error';
  error: ApiErrorBody;
}

export type ServerFrame =
  | ReadyFrame
  | MessageFrame
  | BacklogEndFrame
  | PresenceFrame
  | WaitingFrame
  | AckFrame
  | ErrorFrame;

export interface ReadClientFrame {
  type: 'read';
  seq: number;
  requestId?: string;
}

export interface WaitStartFrame {
  type: 'wait_start';
  requestId: string;
  sinceSeq?: number;
  timeoutSeconds?: number;
}

export interface WaitEndFrame {
  type: 'wait_end';
  requestId: string;
}

export type ClientFrame = ReadClientFrame | WaitStartFrame | WaitEndFrame;
