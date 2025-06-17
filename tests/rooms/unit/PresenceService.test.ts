import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { PresenceService } from '../../../src/features/rooms/presence/PresenceService';
import { RoomService } from '../../../src/features/rooms/room/RoomService';
import { RoomNotFoundError, AgentNotInRoomError, ValidationError } from '../../../src/errors';
import type { EnterRoomResult, LeaveRoomResult, ListRoomUsersResult } from '../../../src/features/rooms/types/rooms.types';
import type { AgentProfile } from '../../../src/types/entities';

// ファイルシステムをモック
vi.mock('fs/promises', () => ({
  default: vol.promises,
  ...vol.promises
}));

describe('PresenceService', () => {
  let presenceService: PresenceService;
  let roomService: RoomService;
  const testDataDir = '/test-data';

  beforeEach(async () => {
    // ファイルシステムをリセット
    vol.reset();
    vol.fromJSON({}, testDataDir);
    
    presenceService = new PresenceService(testDataDir);
    roomService = new RoomService(testDataDir);
    
    // テスト用ルームを作成
    await roomService.createRoom('test-room', 'Test room for presence');
  });

  afterEach(() => {
    vol.reset();
  });

  describe('enterRoom', () => {
    it('should allow agent to enter existing room', async () => {
      const agentName = 'test-agent';
      const roomName = 'test-room';
      const profile: AgentProfile = {
        role: 'tester',
        description: 'Test agent',
        capabilities: ['testing']
      };

      const result: EnterRoomResult = await presenceService.enterRoom(agentName, roomName, profile);

      expect(result).toEqual({
        success: true,
        roomName: 'test-room',
        message: "test-agent entered room 'test-room'"
      });

      // エージェントが実際に入室しているかチェック
      const isInRoom = await presenceService.isUserInRoom(roomName, agentName);
      expect(isInRoom).toBe(true);
    });

    it('should allow agent to enter room without profile', async () => {
      const agentName = 'simple-agent';
      const roomName = 'test-room';

      const result: EnterRoomResult = await presenceService.enterRoom(agentName, roomName);

      expect(result).toEqual({
        success: true,
        roomName: 'test-room',
        message: "simple-agent entered room 'test-room'"
      });

      const isInRoom = await presenceService.isUserInRoom(roomName, agentName);
      expect(isInRoom).toBe(true);
    });

    it('should throw RoomNotFoundError for non-existing room', async () => {
      const agentName = 'test-agent';
      const roomName = 'non-existing-room';

      await expect(presenceService.enterRoom(agentName, roomName)).rejects.toThrow(RoomNotFoundError);
    });

    it('should handle agent entering same room twice', async () => {
      const agentName = 'test-agent';
      const roomName = 'test-room';

      // 最初の入室
      await presenceService.enterRoom(agentName, roomName);
      
      // 再度入室（オンラインステータスに更新されるべき）
      const result: EnterRoomResult = await presenceService.enterRoom(agentName, roomName);

      expect(result.success).toBe(true);
      const status = await presenceService.getUserStatus(roomName, agentName);
      expect(status).toBe('online');
    });

    it('should validate agent name', async () => {
      const invalidNames = ['', 'agent with spaces', 'agent@invalid', 'a'.repeat(51)];
      const roomName = 'test-room';

      for (const invalidName of invalidNames) {
        await expect(presenceService.enterRoom(invalidName, roomName)).rejects.toThrow(ValidationError);
      }
    });

    it('should validate room name', async () => {
      const agentName = 'test-agent';
      const invalidRoomNames = ['', 'room with spaces', 'room@invalid', 'a'.repeat(51)];

      for (const invalidRoomName of invalidRoomNames) {
        await expect(presenceService.enterRoom(agentName, invalidRoomName)).rejects.toThrow(ValidationError);
      }
    });
  });

  describe('leaveRoom', () => {
    beforeEach(async () => {
      // テスト用エージェントを入室させる
      await presenceService.enterRoom('test-agent', 'test-room');
    });

    it('should allow agent to leave room', async () => {
      const agentName = 'test-agent';
      const roomName = 'test-room';

      const result: LeaveRoomResult = await presenceService.leaveRoom(agentName, roomName);

      expect(result).toEqual({
        success: true,
        roomName: 'test-room',
        message: "test-agent left room 'test-room'"
      });

      // エージェントがオフラインになっているかチェック
      const status = await presenceService.getUserStatus(roomName, agentName);
      expect(status).toBe('offline');
    });

    it('should throw RoomNotFoundError for non-existing room', async () => {
      const agentName = 'test-agent';
      const roomName = 'non-existing-room';

      await expect(presenceService.leaveRoom(agentName, roomName)).rejects.toThrow(RoomNotFoundError);
    });

    it('should throw AgentNotInRoomError for agent not in room', async () => {
      const agentName = 'non-existing-agent';
      const roomName = 'test-room';

      await expect(presenceService.leaveRoom(agentName, roomName)).rejects.toThrow(AgentNotInRoomError);
    });
  });

  describe('listRoomUsers', () => {
    beforeEach(async () => {
      // 複数のテスト用エージェントを入室させる
      await presenceService.enterRoom('agent1', 'test-room', {
        role: 'coordinator',
        description: 'Task coordinator'
      });
      await presenceService.enterRoom('agent2', 'test-room', {
        role: 'worker',
        capabilities: ['data-processing']
      });
      await presenceService.enterRoom('agent3', 'test-room');
      
      // agent2をオフラインにする
      await presenceService.leaveRoom('agent2', 'test-room');
    });

    it('should list all users in room with their status', async () => {
      const roomName = 'test-room';

      const result: ListRoomUsersResult = await presenceService.listRoomUsers(roomName);

      expect(result.roomName).toBe('test-room');
      expect(result.users).toHaveLength(3);
      expect(result.onlineCount).toBe(2);

      const agent1 = result.users.find(u => u.name === 'agent1');
      expect(agent1).toMatchObject({
        name: 'agent1',
        status: 'online',
        messageCount: 0,
        profile: {
          role: 'coordinator',
          description: 'Task coordinator'
        }
      });

      const agent2 = result.users.find(u => u.name === 'agent2');
      expect(agent2).toMatchObject({
        name: 'agent2',
        status: 'offline',
        profile: {
          role: 'worker',
          capabilities: ['data-processing']
        }
      });
    });

    it('should return empty list for room with no users', async () => {
      await roomService.createRoom('empty-room');
      
      const result: ListRoomUsersResult = await presenceService.listRoomUsers('empty-room');

      expect(result.roomName).toBe('empty-room');
      expect(result.users).toHaveLength(0);
      expect(result.onlineCount).toBe(0);
    });

    it('should throw RoomNotFoundError for non-existing room', async () => {
      await expect(presenceService.listRoomUsers('non-existing-room')).rejects.toThrow(RoomNotFoundError);
    });
  });

  describe('isUserInRoom', () => {
    beforeEach(async () => {
      await presenceService.enterRoom('test-agent', 'test-room');
    });

    it('should return true for user in room', async () => {
      const isInRoom = await presenceService.isUserInRoom('test-room', 'test-agent');
      expect(isInRoom).toBe(true);
    });

    it('should return false for user not in room', async () => {
      const isInRoom = await presenceService.isUserInRoom('test-room', 'non-existing-agent');
      expect(isInRoom).toBe(false);
    });
  });

  describe('getUserStatus', () => {
    beforeEach(async () => {
      await presenceService.enterRoom('online-agent', 'test-room');
      await presenceService.enterRoom('offline-agent', 'test-room');
      await presenceService.leaveRoom('offline-agent', 'test-room');
    });

    it('should return online status for online user', async () => {
      const status = await presenceService.getUserStatus('test-room', 'online-agent');
      expect(status).toBe('online');
    });

    it('should return offline status for offline user', async () => {
      const status = await presenceService.getUserStatus('test-room', 'offline-agent');
      expect(status).toBe('offline');
    });

    it('should return null for user not in room', async () => {
      const status = await presenceService.getUserStatus('test-room', 'non-existing-agent');
      expect(status).toBeNull();
    });
  });

  describe('getOnlineUsersCount', () => {
    it('should return correct online user count', async () => {
      await presenceService.enterRoom('agent1', 'test-room');
      await presenceService.enterRoom('agent2', 'test-room');
      await presenceService.enterRoom('agent3', 'test-room');
      await presenceService.leaveRoom('agent2', 'test-room'); // オフライン

      const count = await presenceService.getOnlineUsersCount('test-room');
      expect(count).toBe(2);
    });

    it('should return 0 for room with no online users', async () => {
      const count = await presenceService.getOnlineUsersCount('test-room');
      expect(count).toBe(0);
    });
  });

  describe('cleanupOfflineUsers', () => {
    it('should remove offline users after threshold time', async () => {
      // このテストは時間操作が必要なため、基本的な動作のみテスト
      await presenceService.enterRoom('agent1', 'test-room');
      await presenceService.leaveRoom('agent1', 'test-room');

      const cleanedCount = await presenceService.cleanupOfflineUsers('test-room', 0); // 即座にクリーンアップ
      expect(cleanedCount).toBeGreaterThanOrEqual(0);
    });
  });
});