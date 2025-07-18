// Agent Communication MCP Server - Room Service Implementation
// エージェントB担当：ルーム管理ビジネスロジック

import { IRoomService, IRoomStorage, IPresenceStorage, CreateRoomResult, ListRoomsResult, RoomData, RoomListItem, EnterRoomResult, LeaveRoomResult, ListRoomUsersResult } from '../types/rooms.types';
import { RoomStorage } from './RoomStorage';
import { PresenceStorage } from '../presence/PresenceStorage';
import { PresenceService } from '../presence/PresenceService';
import { RoomAlreadyExistsError, RoomNotFoundError, ValidationError } from '../../../errors';
import { getDataDirectory } from '../../../utils/dataDir';
import { LockService } from '../../../services/LockService';

export class RoomService implements IRoomService {
  private roomStorage: IRoomStorage;
  private presenceStorage: IPresenceStorage;
  private presenceService: PresenceService;
  private lockService: LockService;

  constructor(dataDir: string = getDataDirectory(), lockService?: LockService) {
    this.lockService = lockService || new LockService(dataDir);
    this.roomStorage = new RoomStorage(dataDir, this.lockService);
    this.presenceStorage = new PresenceStorage(dataDir, this.lockService);
    this.presenceService = new PresenceService(dataDir, this.lockService);
  }

  async createRoom(params: { roomName: string; description?: string } | string, description?: string): Promise<CreateRoomResult> {
    // Handle both old API (string, string) and new API ({ roomName, description })
    let roomName: string;
    let desc: string | undefined;
    
    if (typeof params === 'string') {
      // Old API: createRoom(roomName, description)
      roomName = params;
      desc = description;
    } else {
      // New API: createRoom({ roomName, description })
      roomName = params.roomName;
      desc = params.description;
    }
    
    // バリデーション
    this.validateRoomName(roomName);
    
    if (desc !== undefined) {
      this.validateDescription(desc);
    }

    // 既存ルームチェック
    const exists = await this.roomStorage.roomExists(roomName);
    if (exists) {
      throw new RoomAlreadyExistsError(roomName);
    }

    // ルーム作成
    await this.roomStorage.createRoom(roomName, desc);

    return {
      success: true,
      roomName,
      message: `Room '${roomName}' created successfully`
    };
  }

  async listRooms(agentName?: string): Promise<ListRoomsResult> {
    const roomsData = await this.roomStorage.readRooms();
    const rooms: RoomListItem[] = [];

    for (const [roomName, roomData] of Object.entries(roomsData.rooms)) {
      const roomItem: RoomListItem = {
        name: roomName,
        description: roomData.description,
        userCount: roomData.userCount,
        messageCount: roomData.messageCount
      };

      // agentNameが指定されている場合、そのエージェントが参加しているかチェック
      if (agentName) {
        try {
          const isJoined = await this.presenceStorage.isUserInRoom(roomName, agentName);
          roomItem.isJoined = isJoined;
        } catch (error) {
          // プレゼンスファイルが存在しない場合はfalse
          roomItem.isJoined = false;
        }
      }

      rooms.push(roomItem);
    }

    // ルーム名でソート
    rooms.sort((a, b) => a.name.localeCompare(b.name));

    return { rooms };
  }

  async roomExists(roomName: string): Promise<boolean> {
    return await this.roomStorage.roomExists(roomName);
  }

  async getRoomData(roomName: string): Promise<RoomData | null> {
    return await this.roomStorage.getRoomData(roomName);
  }

  // 内部ユーティリティメソッド
  async updateRoomUserCount(roomName: string): Promise<void> {
    try {
      // プレゼンスデータから現在のユーザー数を取得
      const presenceData = await this.presenceStorage.readPresence(roomName);
      const onlineCount = Object.values(presenceData.users).filter(user => user.status === 'online').length;
      
      // ルームデータのユーザー数を更新
      await this.roomStorage.updateRoomUserCount(roomName, onlineCount);
    } catch (error) {
      // プレゼンスファイルが存在しない場合は0に設定
      await this.roomStorage.updateRoomUserCount(roomName, 0);
    }
  }

  // バリデーションメソッド
  private validateRoomName(roomName: string): void {
    if (!roomName || typeof roomName !== 'string') {
      throw new ValidationError('roomName', 'Room name is required and must be a string');
    }

    if (roomName.length === 0) {
      throw new ValidationError('roomName', 'Room name cannot be empty');
    }

    if (roomName.length > 50) {
      throw new ValidationError('roomName', 'Room name cannot exceed 50 characters');
    }

    // 英数字、ハイフン、アンダースコアのみ許可
    const validPattern = /^[a-zA-Z0-9-_]+$/;
    if (!validPattern.test(roomName)) {
      throw new ValidationError('roomName', 'Room name can only contain alphanumeric characters, hyphens, and underscores');
    }
  }

  private validateDescription(description: string): void {
    if (typeof description !== 'string') {
      throw new ValidationError('description', 'Description must be a string');
    }

    if (description.length > 200) {
      throw new ValidationError('description', 'Description cannot exceed 200 characters');
    }
  }

  // 管理・統計メソッド
  async getAllRoomNames(): Promise<string[]> {
    return await this.roomStorage.getAllRoomNames();
  }

  async getRoomCount(): Promise<number> {
    const roomNames = await this.getAllRoomNames();
    return roomNames.length;
  }

  async getRoomStatistics(roomName: string): Promise<{
    name: string;
    userCount: number;
    onlineCount: number;
    messageCount: number;
    createdAt: string;
  } | null> {
    const roomData = await this.getRoomData(roomName);
    if (!roomData) {
      return null;
    }

    let onlineCount = 0;
    try {
      const presenceData = await this.presenceStorage.readPresence(roomName);
      onlineCount = Object.values(presenceData.users).filter(user => user.status === 'online').length;
    } catch (error) {
      // プレゼンスファイルが存在しない場合は0
      onlineCount = 0;
    }

    return {
      name: roomName,
      userCount: roomData.userCount,
      onlineCount,
      messageCount: roomData.messageCount,
      createdAt: roomData.createdAt
    };
  }

  // テスト・デバッグ用メソッド
  async clearAllRooms(): Promise<void> {
    await this.roomStorage.clearAllRooms();
  }

  // Presence delegation methods for compatibility
  async enterRoom(params: { agentName: string; roomName: string; profile?: any } | string, roomName?: string, profile?: any): Promise<EnterRoomResult> {
    // Handle both old API (agentName, roomName, profile) and new API ({ agentName, roomName, profile })
    let agentName: string;
    let room: string;
    let prof: any;
    
    if (typeof params === 'string') {
      // Old API: enterRoom(agentName, roomName, profile)
      agentName = params;
      room = roomName!;
      prof = profile;
    } else {
      // New API: enterRoom({ agentName, roomName, profile })
      agentName = params.agentName;
      room = params.roomName;
      prof = params.profile;
    }
    
    return await this.presenceService.enterRoom(agentName, room, prof);
  }

  async leaveRoom(params: { agentName: string; roomName: string } | string, roomName?: string): Promise<LeaveRoomResult> {
    // Handle both old API (agentName, roomName) and new API ({ agentName, roomName })
    let agentName: string;
    let room: string;
    
    if (typeof params === 'string') {
      // Old API: leaveRoom(agentName, roomName)
      agentName = params;
      room = roomName!;
    } else {
      // New API: leaveRoom({ agentName, roomName })
      agentName = params.agentName;
      room = params.roomName;
    }
    
    return await this.presenceService.leaveRoom(agentName, room);
  }

  async listRoomUsers(params: { roomName: string } | string): Promise<ListRoomUsersResult> {
    // Handle both old API (roomName) and new API ({ roomName })
    let room: string;
    
    if (typeof params === 'string') {
      // Old API: listRoomUsers(roomName)
      room = params;
    } else {
      // New API: listRoomUsers({ roomName })
      room = params.roomName;
    }
    
    return await this.presenceService.listRoomUsers(room);
  }
}