import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { RoomsAPI } from '../../../src/features/rooms';
import type { AgentProfile } from '../../../src/types/entities';

// ファイルシステムをモック
vi.mock('fs/promises', () => ({
  default: vol.promises,
  ...vol.promises
}));

describe('Room Lifecycle Integration Tests', () => {
  let roomsAPI: RoomsAPI;
  const testDataDir = '/integration-test-data';

  beforeEach(() => {
    // ファイルシステムをリセット
    vol.reset();
    vol.fromJSON({}, testDataDir);
    
    roomsAPI = new RoomsAPI(testDataDir);
  });

  afterEach(() => {
    vol.reset();
  });

  describe('Complete room lifecycle', () => {
    it('should handle create → enter → leave → cleanup flow', async () => {
      const roomName = 'lifecycle-room';
      const description = 'Lifecycle test room';

      // 1. ルーム作成
      const createResult = await roomsAPI.createRoom(roomName, description);
      expect(createResult.success).toBe(true);
      expect(createResult.roomName).toBe(roomName);

      // 2. ルーム存在確認
      const exists = await roomsAPI.roomExists(roomName);
      expect(exists).toBe(true);

      // 3. 初期状態のルーム情報確認
      const roomData = await roomsAPI.getRoomData(roomName);
      expect(roomData).toMatchObject({
        description,
        messageCount: 0,
        userCount: 0
      });

      // 4. エージェント1入室
      const agent1Profile: AgentProfile = {
        role: 'coordinator',
        description: 'Test coordinator',
        capabilities: ['planning', 'coordination']
      };

      const enterResult1 = await roomsAPI.enterRoom('agent1', roomName, agent1Profile);
      expect(enterResult1.success).toBe(true);

      // 5. エージェント2入室
      const agent2Profile: AgentProfile = {
        role: 'worker',
        capabilities: ['execution']
      };

      const enterResult2 = await roomsAPI.enterRoom('agent2', roomName, agent2Profile);
      expect(enterResult2.success).toBe(true);

      // 6. ルーム内ユーザー確認
      const users = await roomsAPI.getRoomUsers(roomName);
      expect(users.roomName).toBe(roomName);
      expect(users.users).toHaveLength(2);
      expect(users.onlineCount).toBe(2);

      const agent1User = users.users.find(u => u.name === 'agent1');
      expect(agent1User).toMatchObject({
        name: 'agent1',
        status: 'online',
        messageCount: 0,
        profile: agent1Profile
      });

      // 7. ルーム一覧確認（参加状況付き）
      const roomsWithAgent = await roomsAPI.listRooms('agent1');
      expect(roomsWithAgent.rooms).toHaveLength(1);
      expect(roomsWithAgent.rooms[0]).toMatchObject({
        name: roomName,
        description,
        userCount: 2,
        messageCount: 0,
        isJoined: true
      });

      // 8. 統計情報確認
      const onlineCount = await roomsAPI.getOnlineUsersCount(roomName);
      expect(onlineCount).toBe(2);

      const totalRooms = await roomsAPI.getRoomCount();
      expect(totalRooms).toBe(1);

      // 9. エージェント1退室
      const leaveResult1 = await roomsAPI.leaveRoom('agent1', roomName);
      expect(leaveResult1.success).toBe(true);

      // 10. 退室後の状態確認
      const usersAfterLeave = await roomsAPI.getRoomUsers(roomName);
      expect(usersAfterLeave.onlineCount).toBe(1);
      
      const agent1AfterLeave = usersAfterLeave.users.find(u => u.name === 'agent1');
      expect(agent1AfterLeave?.status).toBe('offline');

      // 11. エージェント2も退室
      await roomsAPI.leaveRoom('agent2', roomName);

      // 12. 最終状態確認
      const finalUsers = await roomsAPI.getRoomUsers(roomName);
      expect(finalUsers.onlineCount).toBe(0);
      expect(finalUsers.users.every(u => u.status === 'offline')).toBe(true);
    });

    it('should handle multiple rooms with overlapping users', async () => {
      // 複数ルーム作成
      await roomsAPI.createRoom('room-a', 'Room A');
      await roomsAPI.createRoom('room-b', 'Room B');
      await roomsAPI.createRoom('room-c', 'Room C');

      // エージェントを異なるルームに配置
      await roomsAPI.enterRoom('agent1', 'room-a', { role: 'coordinator' });
      await roomsAPI.enterRoom('agent1', 'room-b', { role: 'coordinator' });
      await roomsAPI.enterRoom('agent2', 'room-a', { role: 'worker' });
      await roomsAPI.enterRoom('agent2', 'room-c', { role: 'worker' });
      await roomsAPI.enterRoom('agent3', 'room-b', { role: 'observer' });

      // 各ルームの状態確認
      const roomAUsers = await roomsAPI.getRoomUsers('room-a');
      expect(roomAUsers.onlineCount).toBe(2); // agent1, agent2

      const roomBUsers = await roomsAPI.getRoomUsers('room-b');
      expect(roomBUsers.onlineCount).toBe(2); // agent1, agent3

      const roomCUsers = await roomsAPI.getRoomUsers('room-c');
      expect(roomCUsers.onlineCount).toBe(1); // agent2

      // agent1のルーム参加状況確認
      const agent1Rooms = await roomsAPI.listRooms('agent1');
      const joinedRooms = agent1Rooms.rooms.filter(r => r.isJoined);
      expect(joinedRooms.map(r => r.name).sort()).toEqual(['room-a', 'room-b']);

      // 全体統計
      const totalRooms = await roomsAPI.getRoomCount();
      expect(totalRooms).toBe(3);

      const allRoomNames = await roomsAPI.getAllRoomNames();
      expect(allRoomNames.sort()).toEqual(['room-a', 'room-b', 'room-c']);
    });

    it('should handle error scenarios gracefully', async () => {
      const roomName = 'error-test-room';

      // 存在しないルームへの入室
      await expect(
        roomsAPI.enterRoom('agent1', 'non-existing-room')
      ).rejects.toThrow();

      // ルーム作成
      await roomsAPI.createRoom(roomName);

      // 重複ルーム作成
      await expect(
        roomsAPI.createRoom(roomName)
      ).rejects.toThrow();

      // 入室していないエージェントの退室
      await expect(
        roomsAPI.leaveRoom('non-existing-agent', roomName)
      ).rejects.toThrow();

      // 存在しないルームのユーザー一覧
      await expect(
        roomsAPI.getRoomUsers('non-existing-room')
      ).rejects.toThrow();

      // 不正な名前でのルーム作成
      await expect(
        roomsAPI.createRoom('invalid room name')
      ).rejects.toThrow();
    });

    it('should maintain data consistency across operations', async () => {
      const roomName = 'consistency-room';
      
      // ルーム作成
      await roomsAPI.createRoom(roomName, 'Consistency test');

      // 複数エージェント入室
      const agents = ['agent1', 'agent2', 'agent3', 'agent4', 'agent5'];
      for (const agent of agents) {
        await roomsAPI.enterRoom(agent, roomName, {
          role: 'tester',
          description: `Test agent ${agent}`
        });
      }

      // 初期状態確認
      let users = await roomsAPI.getRoomUsers(roomName);
      expect(users.onlineCount).toBe(5);

      // 一部エージェント退室
      await roomsAPI.leaveRoom('agent2', roomName);
      await roomsAPI.leaveRoom('agent4', roomName);

      // 中間状態確認
      users = await roomsAPI.getRoomUsers(roomName);
      expect(users.onlineCount).toBe(3);
      expect(users.users).toHaveLength(5); // オフラインユーザーも含む

      // ルーム一覧での数値一致確認
      const roomsList = await roomsAPI.listRooms();
      const testRoom = roomsList.rooms.find(r => r.name === roomName);
      expect(testRoom?.userCount).toBe(3); // オンラインユーザー数

      // 残りエージェント退室
      await roomsAPI.leaveRoom('agent1', roomName);
      await roomsAPI.leaveRoom('agent3', roomName);
      await roomsAPI.leaveRoom('agent5', roomName);

      // 最終状態確認
      users = await roomsAPI.getRoomUsers(roomName);
      expect(users.onlineCount).toBe(0);

      const finalRoomsList = await roomsAPI.listRooms();
      const finalTestRoom = finalRoomsList.rooms.find(r => r.name === roomName);
      expect(finalTestRoom?.userCount).toBe(0);
    });

    it('should handle offline user cleanup', async () => {
      const roomName = 'cleanup-room';
      
      await roomsAPI.createRoom(roomName);
      
      // エージェント入室・退室
      await roomsAPI.enterRoom('temp-agent1', roomName);
      await roomsAPI.enterRoom('temp-agent2', roomName);
      await roomsAPI.leaveRoom('temp-agent1', roomName);
      await roomsAPI.leaveRoom('temp-agent2', roomName);

      // 初期状態：オフラインユーザーが存在
      let users = await roomsAPI.getRoomUsers(roomName);
      expect(users.users).toHaveLength(2);
      expect(users.onlineCount).toBe(0);

      // クリーンアップ実行（即座にクリーンアップ）
      const cleanedCount = await roomsAPI.cleanupOfflineUsers(roomName, 0);
      expect(cleanedCount).toBe(2);

      // クリーンアップ後：ユーザーが削除されている
      users = await roomsAPI.getRoomUsers(roomName);
      expect(users.users).toHaveLength(0);
      expect(users.onlineCount).toBe(0);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle rapid enter/leave operations', async () => {
      const roomName = 'rapid-ops-room';
      await roomsAPI.createRoom(roomName);

      // 短時間で多数の操作を実行
      const operations = [];
      
      // 入室操作
      for (let i = 1; i <= 10; i++) {
        operations.push(
          roomsAPI.enterRoom(`agent${i}`, roomName, { role: 'rapid-tester' })
        );
      }

      // すべての入室操作を並行実行
      const enterResults = await Promise.all(operations);
      expect(enterResults.every(r => r.success)).toBe(true);

      // 状態確認
      let users = await roomsAPI.getRoomUsers(roomName);
      expect(users.onlineCount).toBe(10);

      // 退室操作
      const leaveOperations = [];
      for (let i = 1; i <= 10; i++) {
        leaveOperations.push(
          roomsAPI.leaveRoom(`agent${i}`, roomName)
        );
      }

      const leaveResults = await Promise.all(leaveOperations);
      expect(leaveResults.every(r => r.success)).toBe(true);

      // 最終状態確認
      users = await roomsAPI.getRoomUsers(roomName);
      expect(users.onlineCount).toBe(0);
    });

    it('should handle agent re-entering same room', async () => {
      const roomName = 'reentry-room';
      const agentName = 'reentry-agent';

      await roomsAPI.createRoom(roomName);

      // 初回入室
      let result = await roomsAPI.enterRoom(agentName, roomName, {
        role: 'initial',
        description: 'Initial entry'
      });
      expect(result.success).toBe(true);

      // 状態確認
      let users = await roomsAPI.getRoomUsers(roomName);
      let agent = users.users.find(u => u.name === agentName);
      expect(agent?.status).toBe('online');
      expect(agent?.profile?.role).toBe('initial');

      // 退室
      await roomsAPI.leaveRoom(agentName, roomName);

      // オフライン確認
      users = await roomsAPI.getRoomUsers(roomName);
      agent = users.users.find(u => u.name === agentName);
      expect(agent?.status).toBe('offline');

      // 再入室（異なるプロフィール）
      result = await roomsAPI.enterRoom(agentName, roomName, {
        role: 'updated',
        description: 'Updated entry',
        capabilities: ['new-skill']
      });
      expect(result.success).toBe(true);

      // 再入室後の状態確認
      users = await roomsAPI.getRoomUsers(roomName);
      agent = users.users.find(u => u.name === agentName);
      expect(agent?.status).toBe('online');
      expect(agent?.profile?.role).toBe('updated');
      expect(agent?.profile?.capabilities).toEqual(['new-skill']);
    });
  });
});