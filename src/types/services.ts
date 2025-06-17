// Agent Communication MCP Server - サービスインターフェース定義
// 設計計画書の86-127行目の仕様に完全準拠

import {
  Room,
  Message,
  AgentProfile,
  Presence,
  RoomListResponse,
  MessageListResponse,
  StatusResponse,
  ClearResult,
  RoomStatistics,
  SendMessageParams,
  GetMessagesParams,
  ReadOptions,
} from './entities';

// ストレージサービスインターフェース
export interface IStorageService {
  // ファイル操作
  readJSON<T>(path: string): Promise<T>;
  writeJSON<T>(path: string, data: T): Promise<void>;
  appendJSONL(path: string, data: any): Promise<void>;
  readJSONL<T>(path: string, options?: ReadOptions): Promise<T[]>;
  
  // ロック機構
  withLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
  
  // ユーティリティ
  exists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
}

// ルーム管理サービスインターフェース
export interface IRoomService {
  // ルーム管理
  createRoom(roomName: string, description?: string): Promise<Room>;
  listRooms(agentName?: string): Promise<RoomListResponse>;
  deleteRoom(roomName: string): Promise<void>;
  
  // プレゼンス管理
  enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<void>;
  leaveRoom(agentName: string, roomName: string): Promise<void>;
  listRoomUsers(roomName: string): Promise<Presence[]>;
  updatePresence(roomName: string, agentName: string, status: 'online' | 'offline'): Promise<void>;
}

// メッセージングサービスインターフェース
export interface IMessageService {
  sendMessage(params: SendMessageParams): Promise<Message>;
  getMessages(params: GetMessagesParams): Promise<MessageListResponse>;
  deleteMessage(roomName: string, messageId: string): Promise<void>;
}

// 管理機能サービスインターフェース
export interface IManagementService {
  getStatus(roomName?: string): Promise<StatusResponse>;
  clearRoomMessages(roomName: string): Promise<ClearResult>;
  getRoomStatistics(roomName: string): Promise<RoomStatistics>;
}

// サービス依存関係の統合インターフェース
export interface IServiceContainer {
  storageService: IStorageService;
  roomService: IRoomService;
  messageService: IMessageService;
  managementService: IManagementService;
}

// サービス設定
export interface ServiceConfig {
  dataDir: string;
  lockTimeout: number;
  maxMessages: number;
  maxRooms: number;
  enableDebugLogging?: boolean;
}