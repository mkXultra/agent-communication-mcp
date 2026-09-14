// Agent Communication MCP Server - Cloud API types
// Shapes from docs/api.yaml (Agent Communication Cloud API 0.4.x, components.schemas).

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

export interface ApiRoomStatus {
  roomName: string;
  epoch?: string;
  messageCount: number;
  agentCount: number;
  onlineCount: number;
  connectedCount: number;
  waitingCount?: number;
  storageBytes?: number;
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
