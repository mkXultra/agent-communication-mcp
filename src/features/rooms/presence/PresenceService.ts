// Agent Communication MCP Server - Presence Service Implementation
// エージェントB担当：プレゼンス管理ビジネスロジック

import { IPresenceService, IRoomStorage, IPresenceStorage, EnterRoomResult, LeaveRoomResult, ListRoomUsersResult, RoomUser } from '../types/rooms.types';
import { AgentProfile } from '../../../types/entities';
import { RoomStorage } from '../room/RoomStorage';
import { PresenceStorage } from './PresenceStorage';
import { RoomNotFoundError, AgentAlreadyInRoomError, AgentNotInRoomError, ValidationError } from '../../../errors';
import { getDataDirectory } from '../../../utils/dataDir';
import { LockService } from '../../../services/LockService';

export class PresenceService implements IPresenceService {
  private roomStorage: IRoomStorage;
  private presenceStorage: IPresenceStorage;
  private lockService: LockService;

  constructor(dataDir: string = getDataDirectory(), lockService?: LockService) {
    this.lockService = lockService || new LockService(dataDir);
    this.roomStorage = new RoomStorage(dataDir, this.lockService);
    this.presenceStorage = new PresenceStorage(dataDir, this.lockService);
  }

  async enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<EnterRoomResult> {
    // バリデーション
    this.validateAgentName(agentName);
    this.validateRoomName(roomName);
    
    if (profile) {
      this.validateProfile(profile);
    }

    // ルーム存在チェック
    const roomExists = await this.roomStorage.roomExists(roomName);
    if (!roomExists) {
      throw new RoomNotFoundError(roomName);
    }

    // 既に入室済みかチェック
    const isAlreadyInRoom = await this.presenceStorage.isUserInRoom(roomName, agentName);
    if (isAlreadyInRoom) {
      // 既に入室済みの場合は、ステータスをオンラインに更新し、プロファイルも更新
      const userStatus = await this.presenceStorage.getUserStatus(roomName, agentName);
      if (userStatus === 'offline') {
        // オフラインユーザーの再入室：addUserでプロファイルを更新
        await this.presenceStorage.addUser(roomName, agentName, profile);
      } else {
        // すでにオンラインの場合は何もしない（二重入室防止）
        // または、プロファイルの更新を許可する場合はaddUserを呼ぶ
        await this.presenceStorage.addUser(roomName, agentName, profile);
      }
    } else {
      // 新規入室
      await this.presenceStorage.addUser(roomName, agentName, profile);
    }

    // ルームのユーザー数を更新
    await this.updateRoomUserCount(roomName);

    return {
      success: true,
      roomName,
      message: `${agentName} entered room '${roomName}'`
    };
  }

  async leaveRoom(agentName: string, roomName: string): Promise<LeaveRoomResult> {
    // バリデーション
    this.validateAgentName(agentName);
    this.validateRoomName(roomName);

    // ルーム存在チェック
    const roomExists = await this.roomStorage.roomExists(roomName);
    if (!roomExists) {
      throw new RoomNotFoundError(roomName);
    }

    // 入室しているかチェック
    const isInRoom = await this.presenceStorage.isUserInRoom(roomName, agentName);
    if (!isInRoom) {
      throw new AgentNotInRoomError(agentName, roomName);
    }

    // オフラインステータスに更新（完全削除ではなく、オフラインにする）
    await this.presenceStorage.updateUserStatus(roomName, agentName, 'offline');

    // ルームのユーザー数を更新
    await this.updateRoomUserCount(roomName);

    return {
      success: true,
      roomName,
      message: `${agentName} left room '${roomName}'`
    };
  }

  async listRoomUsers(roomName: string): Promise<ListRoomUsersResult> {
    // バリデーション
    this.validateRoomName(roomName);

    // ルーム存在チェック
    const roomExists = await this.roomStorage.roomExists(roomName);
    if (!roomExists) {
      throw new RoomNotFoundError(roomName);
    }

    // プレゼンスデータを取得
    const presenceData = await this.presenceStorage.readPresence(roomName);
    
    const users: RoomUser[] = [];
    let onlineCount = 0;

    for (const [userName, userData] of Object.entries(presenceData.users)) {
      const user: RoomUser = {
        name: userName,
        status: userData.status,
        messageCount: userData.messageCount,
        profile: userData.profile
      };

      users.push(user);

      if (userData.status === 'online') {
        onlineCount++;
      }
    }

    // ユーザー名でソート
    users.sort((a, b) => a.name.localeCompare(b.name));

    return {
      roomName,
      users,
      onlineCount
    };
  }

  async isUserInRoom(roomName: string, agentName: string): Promise<boolean> {
    return await this.presenceStorage.isUserInRoom(roomName, agentName);
  }

  async getUserStatus(roomName: string, agentName: string): Promise<'online' | 'offline' | null> {
    return await this.presenceStorage.getUserStatus(roomName, agentName);
  }

  // 内部ユーティリティメソッド
  private async updateRoomUserCount(roomName: string): Promise<void> {
    try {
      const onlineCount = await this.presenceStorage.getOnlineUsersCount(roomName);
      await this.roomStorage.updateRoomUserCount(roomName, onlineCount);
    } catch (error) {
      // エラーが発生した場合はログに記録するが、処理は継続
      console.error(`Failed to update user count for room '${roomName}':`, error);
    }
  }

  // バリデーションメソッド
  private validateAgentName(agentName: string): void {
    if (!agentName || typeof agentName !== 'string') {
      throw new ValidationError('agentName', 'Agent name is required and must be a string');
    }

    if (agentName.length === 0) {
      throw new ValidationError('agentName', 'Agent name cannot be empty');
    }

    if (agentName.length > 50) {
      throw new ValidationError('agentName', 'Agent name cannot exceed 50 characters');
    }

    // 英数字、ハイフン、アンダースコアのみ許可
    const validPattern = /^[a-zA-Z0-9-_]+$/;
    if (!validPattern.test(agentName)) {
      throw new ValidationError('agentName', 'Agent name can only contain alphanumeric characters, hyphens, and underscores');
    }
  }

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

  private validateProfile(profile: AgentProfile): void {
    if (typeof profile !== 'object' || profile === null) {
      throw new ValidationError('profile', 'Profile must be an object');
    }

    if (profile.role !== undefined) {
      if (typeof profile.role !== 'string') {
        throw new ValidationError('profile.role', 'Profile role must be a string');
      }
      if (profile.role.length > 50) {
        throw new ValidationError('profile.role', 'Profile role cannot exceed 50 characters');
      }
    }

    if (profile.description !== undefined) {
      if (typeof profile.description !== 'string') {
        throw new ValidationError('profile.description', 'Profile description must be a string');
      }
      if (profile.description.length > 200) {
        throw new ValidationError('profile.description', 'Profile description cannot exceed 200 characters');
      }
    }

    if (profile.capabilities !== undefined) {
      if (!Array.isArray(profile.capabilities)) {
        throw new ValidationError('profile.capabilities', 'Profile capabilities must be an array');
      }
      if (profile.capabilities.length > 20) {
        throw new ValidationError('profile.capabilities', 'Profile capabilities cannot exceed 20 items');
      }
      for (const capability of profile.capabilities) {
        if (typeof capability !== 'string') {
          throw new ValidationError('profile.capabilities', 'Each capability must be a string');
        }
        if (capability.length > 50) {
          throw new ValidationError('profile.capabilities', 'Each capability cannot exceed 50 characters');
        }
      }
    }

    if (profile.metadata !== undefined) {
      if (typeof profile.metadata !== 'object' || profile.metadata === null) {
        throw new ValidationError('profile.metadata', 'Profile metadata must be an object');
      }
    }
  }

  // 管理・統計メソッド
  async getOnlineUsersInRoom(roomName: string): Promise<RoomUser[]> {
    const result = await this.listRoomUsers(roomName);
    return result.users.filter(user => user.status === 'online');
  }

  async getOfflineUsersInRoom(roomName: string): Promise<RoomUser[]> {
    const result = await this.listRoomUsers(roomName);
    return result.users.filter(user => user.status === 'offline');
  }

  async getTotalUsersInRoom(roomName: string): Promise<number> {
    const result = await this.listRoomUsers(roomName);
    return result.users.length;
  }

  async getOnlineUsersCount(roomName: string): Promise<number> {
    const result = await this.listRoomUsers(roomName);
    return result.onlineCount;
  }

  // メッセージ数更新（他のエージェントから呼び出される）
  async incrementUserMessageCount(roomName: string, agentName: string): Promise<void> {
    await this.presenceStorage.incrementUserMessageCount(roomName, agentName);
  }

  // オフラインユーザーのクリーンアップ（24時間以上オフライン）
  async cleanupOfflineUsers(roomName: string, thresholdHours: number = 24): Promise<number> {
    const presenceData = await this.presenceStorage.readPresence(roomName);
    const now = new Date();
    const thresholdTime = now.getTime() - (thresholdHours * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    
    for (const [userName, userData] of Object.entries(presenceData.users)) {
      if (userData.status === 'offline') {
        const joinedAt = new Date(userData.joinedAt);
        if (joinedAt.getTime() < thresholdTime) {
          await this.presenceStorage.removeUser(roomName, userName);
          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      await this.updateRoomUserCount(roomName);
    }

    return cleanedCount;
  }

  // テスト・デバッグ用メソッド
  async clearRoomPresence(roomName: string): Promise<void> {
    await this.presenceStorage.clearRoomPresence(roomName);
    await this.updateRoomUserCount(roomName);
  }
}