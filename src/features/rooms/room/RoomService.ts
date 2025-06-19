// Agent Communication MCP Server - Room Service Implementation
// エージェントB担当：ルーム管理ビジネスロジック

import { IRoomService, IRoomStorage, IPresenceStorage, CreateRoomResult, ListRoomsResult, RoomData, RoomListItem } from '../types/rooms.types';
import { RoomStorage } from './RoomStorage';
import { PresenceStorage } from '../presence/PresenceStorage';
import { RoomAlreadyExistsError, RoomNotFoundError, ValidationError } from '../../../errors';
import { getDataDirectory } from '../../../utils/dataDir';

export class RoomService implements IRoomService {
  private roomStorage: IRoomStorage;
  private presenceStorage: IPresenceStorage;

  constructor(dataDir: string = getDataDirectory()) {
    this.roomStorage = new RoomStorage(dataDir);
    this.presenceStorage = new PresenceStorage(dataDir);
  }

  async createRoom(roomName: string, description?: string): Promise<CreateRoomResult> {
    // バリデーション
    this.validateRoomName(roomName);
    
    if (description !== undefined) {
      this.validateDescription(description);
    }

    // 既存ルームチェック
    const exists = await this.roomStorage.roomExists(roomName);
    if (exists) {
      throw new RoomAlreadyExistsError(roomName);
    }

    // ルーム作成
    await this.roomStorage.createRoom(roomName, description);

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
}