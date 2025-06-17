// Agent Communication MCP Server - 基本エンティティ型定義
// 設計計画書の42-80行目の仕様に完全準拠

export interface Room {
  name: string;
  description?: string;
  createdAt: string;
  messageCount: number;
  userCount: number;
}

export interface Message {
  id: string;
  roomName: string;
  agentName: string;
  message: string;
  mentions: string[];
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface Agent {
  name: string;
  profile?: AgentProfile;
}

export interface AgentProfile {
  role?: string;
  description?: string;
  capabilities?: string[];
  metadata?: Record<string, any>;
}

export interface Presence {
  agentName: string;
  status: 'online' | 'offline';
  joinedAt: string;
  messageCount: number;
  profile?: AgentProfile;
}

// 追加のヘルパー型定義
export type PresenceStatus = 'online' | 'offline';

// レスポンス用の型定義
export interface RoomListResponse {
  rooms: Room[];
  total: number;
}

export interface MessageListResponse {
  messages: Message[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

export interface StatusResponse {
  totalRooms: number;
  totalMessages: number;
  totalAgents: number;
  activeRooms: string[];
  onlineAgents: number;
}

export interface ClearResult {
  success: boolean;
  roomName: string;
  deletedCount: number;
}

export interface RoomStatistics {
  roomName: string;
  totalMessages: number;
  uniqueAgents: number;
  messagesByAgent: Record<string, number>;
  firstMessageAt?: string;
  lastMessageAt?: string;
}

// パラメータ用の型定義
export interface SendMessageParams {
  agentName: string;
  roomName: string;
  message: string;
  metadata?: Record<string, any>;
}

export interface GetMessagesParams {
  roomName: string;
  agentName?: string;
  limit?: number;
  cursor?: string;
  since?: string;
  includeMetadata?: boolean;
}

export interface ReadOptions {
  limit?: number;
  offset?: number;
  reverse?: boolean;
}