// Agent Communication MCP Server - Rooms Feature Public API
// エージェントB担当：ルーム・プレゼンス機能公開API

import { RoomService } from './room/RoomService';
import { PresenceService } from './presence/PresenceService';
import { AgentProfile } from '../../types/entities';
import { getDataDirectory } from '../../utils/dataDir';
import {
  CreateRoomResult,
  ListRoomsResult,
  EnterRoomResult,
  LeaveRoomResult,
  ListRoomUsersResult,
  RoomData
} from './types/rooms.types';

// === 公開インターフェース ===

export interface IRoomsAPI {
  // ルーム管理
  createRoom(name: string, description?: string): Promise<CreateRoomResult>;
  roomExists(name: string): Promise<boolean>;
  listRooms(agentName?: string): Promise<ListRoomsResult>;
  getRoomData(name: string): Promise<RoomData | null>;
  
  // プレゼンス管理
  enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<EnterRoomResult>;
  leaveRoom(agentName: string, roomName: string): Promise<LeaveRoomResult>;
  getRoomUsers(roomName: string): Promise<ListRoomUsersResult>;
  isUserInRoom(roomName: string, agentName: string): Promise<boolean>;
  getUserStatus(roomName: string, agentName: string): Promise<'online' | 'offline' | null>;
  
  // 統計・管理
  getRoomCount(): Promise<number>;
  getAllRoomNames(): Promise<string[]>;
  getOnlineUsersCount(roomName: string): Promise<number>;
  cleanupOfflineUsers(roomName: string, thresholdHours?: number): Promise<number>;
}

// === 公開API実装クラス ===

export class RoomsAPI implements IRoomsAPI {
  private roomService: RoomService;
  private presenceService: PresenceService;

  constructor(dataDir: string = getDataDirectory()) {
    this.roomService = new RoomService(dataDir);
    this.presenceService = new PresenceService(dataDir);
  }

  // === ルーム管理 ===

  async createRoom(name: string, description?: string): Promise<CreateRoomResult> {
    return this.roomService.createRoom(name, description);
  }

  async roomExists(name: string): Promise<boolean> {
    return this.roomService.roomExists(name);
  }

  async listRooms(agentName?: string): Promise<ListRoomsResult> {
    return this.roomService.listRooms(agentName);
  }

  async getRoomData(name: string): Promise<RoomData | null> {
    return this.roomService.getRoomData(name);
  }

  // === プレゼンス管理 ===

  async enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<EnterRoomResult> {
    return this.presenceService.enterRoom(agentName, roomName, profile);
  }

  async leaveRoom(agentName: string, roomName: string): Promise<LeaveRoomResult> {
    return this.presenceService.leaveRoom(agentName, roomName);
  }

  async getRoomUsers(roomName: string): Promise<ListRoomUsersResult> {
    return this.presenceService.listRoomUsers(roomName);
  }

  async isUserInRoom(roomName: string, agentName: string): Promise<boolean> {
    return this.presenceService.isUserInRoom(roomName, agentName);
  }

  async getUserStatus(roomName: string, agentName: string): Promise<'online' | 'offline' | null> {
    return this.presenceService.getUserStatus(roomName, agentName);
  }

  // === 統計・管理 ===

  async getRoomCount(): Promise<number> {
    return this.roomService.getRoomCount();
  }

  async getAllRoomNames(): Promise<string[]> {
    return this.roomService.getAllRoomNames();
  }

  async getOnlineUsersCount(roomName: string): Promise<number> {
    return this.presenceService.getOnlineUsersCount(roomName);
  }

  async cleanupOfflineUsers(roomName: string, thresholdHours: number = 24): Promise<number> {
    return this.presenceService.cleanupOfflineUsers(roomName, thresholdHours);
  }

  // === デバッグ・テスト用メソッド ===

  async clearAllRooms(): Promise<void> {
    await this.roomService.clearAllRooms();
  }

  async clearRoomPresence(roomName: string): Promise<void> {
    await this.presenceService.clearRoomPresence(roomName);
  }
}

// === エクスポート ===

// メインAPI - IRoomsAPI interface is already exported above

// サービスクラス
export { RoomService } from './room/RoomService';
export { PresenceService } from './presence/PresenceService';

// ストレージクラス
export { RoomStorage } from './room/RoomStorage';
export { PresenceStorage } from './presence/PresenceStorage';

// 型定義
export * from './types/rooms.types';

// MCPツール
export { roomTools } from './tools/room.tools';
export { presenceTools } from './tools/presence.tools';

// デフォルトエクスポート（メインAPI）
export default RoomsAPI;