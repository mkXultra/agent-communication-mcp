import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { PresenceStorage } from '../../../src/features/rooms/presence/PresenceStorage';
import { StorageError, FileNotFoundError } from '../../../src/errors';
import type { PresenceData, PresenceUser } from '../../../src/features/rooms/types/rooms.types';
import type { AgentProfile } from '../../../src/types/entities';

// ファイルシステムをモック
vi.mock('fs/promises', () => ({
  default: vol.promises,
  ...vol.promises
}));

describe('PresenceStorage', () => {
  let presenceStorage: PresenceStorage;
  const testDataDir = '/test-presence';

  beforeEach(() => {
    // ファイルシステムをリセット
    vol.reset();
    vol.fromJSON({}, testDataDir);
    
    presenceStorage = new PresenceStorage(testDataDir);
  });

  afterEach(() => {
    vol.reset();
  });

  describe('readPresence', () => {
    it('should return empty presence data when file does not exist', async () => {
      const result = await presenceStorage.readPresence('test-room');
      
      expect(result).toEqual({
        roomName: 'test-room',
        users: {}
      });
    });

    it('should read existing presence data', async () => {
      const presenceData: PresenceData = {
        roomName: 'test-room',
        users: {
          'agent1': {
            status: 'online',
            messageCount: 5,
            joinedAt: '2024-01-20T10:00:00Z',
            profile: {
              role: 'tester',
              description: 'Test agent'
            }
          }
        }
      };

      // ファイルを事前に作成
      vol.fromJSON({
        [`${testDataDir}/rooms/test-room/presence.json`]: JSON.stringify(presenceData, null, 2)
      });

      const result = await presenceStorage.readPresence('test-room');
      
      expect(result).toEqual(presenceData);
    });

    it('should create room directory if it does not exist', async () => {
      vol.reset(); // すべてのディレクトリを削除
      
      await expect(presenceStorage.readPresence('new-room')).resolves.not.toThrow();
    });
  });

  describe('writePresence', () => {
    it('should write presence data to file', async () => {
      const presenceData: PresenceData = {
        roomName: 'write-test-room',
        users: {
          'agent1': {
            status: 'online',
            messageCount: 0,
            joinedAt: '2024-01-20T11:00:00Z'
          }
        }
      };

      await presenceStorage.writePresence('write-test-room', presenceData);

      // ファイルが正しく書き込まれたか確認
      const writtenData = await presenceStorage.readPresence('write-test-room');
      expect(writtenData).toEqual(presenceData);
    });
  });

  describe('addUser', () => {
    it('should add user to room', async () => {
      const roomName = 'add-user-room';
      const agentName = 'new-agent';
      const profile: AgentProfile = {
        role: 'coordinator',
        description: 'Coordination agent',
        capabilities: ['planning']
      };

      await presenceStorage.addUser(roomName, agentName, profile);

      const presenceData = await presenceStorage.readPresence(roomName);
      expect(presenceData.users[agentName]).toMatchObject({
        status: 'online',
        messageCount: 0,
        profile
      });
      expect(presenceData.users[agentName].joinedAt).toBeDefined();
    });

    it('should add user without profile', async () => {
      const roomName = 'simple-room';
      const agentName = 'simple-agent';

      await presenceStorage.addUser(roomName, agentName);

      const presenceData = await presenceStorage.readPresence(roomName);
      expect(presenceData.users[agentName]).toMatchObject({
        status: 'online',
        messageCount: 0
      });
      expect(presenceData.users[agentName].profile).toBeUndefined();
    });
  });

  describe('removeUser', () => {
    beforeEach(async () => {
      await presenceStorage.addUser('remove-test-room', 'test-agent');
    });

    it('should remove user from room', async () => {
      await presenceStorage.removeUser('remove-test-room', 'test-agent');

      const presenceData = await presenceStorage.readPresence('remove-test-room');
      expect(presenceData.users['test-agent']).toBeUndefined();
    });

    it('should throw error when user does not exist', async () => {
      await expect(
        presenceStorage.removeUser('remove-test-room', 'non-existing-agent')
      ).rejects.toThrow(FileNotFoundError);
    });
  });

  describe('updateUserStatus', () => {
    beforeEach(async () => {
      await presenceStorage.addUser('status-test-room', 'status-agent');
    });

    it('should update user status', async () => {
      await presenceStorage.updateUserStatus('status-test-room', 'status-agent', 'offline');

      const status = await presenceStorage.getUserStatus('status-test-room', 'status-agent');
      expect(status).toBe('offline');
    });

    it('should throw error when user does not exist', async () => {
      await expect(
        presenceStorage.updateUserStatus('status-test-room', 'non-existing-agent', 'offline')
      ).rejects.toThrow(FileNotFoundError);
    });
  });

  describe('getUsersInRoom', () => {
    beforeEach(async () => {
      await presenceStorage.addUser('users-room', 'agent1', { role: 'coordinator' });
      await presenceStorage.addUser('users-room', 'agent2', { role: 'worker' });
      await presenceStorage.updateUserStatus('users-room', 'agent2', 'offline');
    });

    it('should return all users in room', async () => {
      const users = await presenceStorage.getUsersInRoom('users-room');
      
      expect(users).toHaveLength(2);
      expect(users.find(u => u.profile?.role === 'coordinator')).toBeDefined();
      expect(users.find(u => u.profile?.role === 'worker')).toBeDefined();
    });

    it('should return empty array for room with no users', async () => {
      const users = await presenceStorage.getUsersInRoom('empty-room');
      
      expect(users).toEqual([]);
    });
  });

  describe('isUserInRoom', () => {
    beforeEach(async () => {
      await presenceStorage.addUser('presence-room', 'present-agent');
    });

    it('should return true for user in room', async () => {
      const isInRoom = await presenceStorage.isUserInRoom('presence-room', 'present-agent');
      
      expect(isInRoom).toBe(true);
    });

    it('should return false for user not in room', async () => {
      const isInRoom = await presenceStorage.isUserInRoom('presence-room', 'absent-agent');
      
      expect(isInRoom).toBe(false);
    });
  });

  describe('utility methods', () => {
    beforeEach(async () => {
      await presenceStorage.addUser('util-room', 'agent1');
      await presenceStorage.addUser('util-room', 'agent2');
      await presenceStorage.addUser('util-room', 'agent3');
      await presenceStorage.updateUserStatus('util-room', 'agent2', 'offline');
    });

    describe('getUserStatus', () => {
      it('should return user status', async () => {
        const onlineStatus = await presenceStorage.getUserStatus('util-room', 'agent1');
        const offlineStatus = await presenceStorage.getUserStatus('util-room', 'agent2');
        
        expect(onlineStatus).toBe('online');
        expect(offlineStatus).toBe('offline');
      });

      it('should return null for non-existing user', async () => {
        const status = await presenceStorage.getUserStatus('util-room', 'non-existing');
        
        expect(status).toBeNull();
      });
    });

    describe('getOnlineUsersCount', () => {
      it('should return correct online user count', async () => {
        const count = await presenceStorage.getOnlineUsersCount('util-room');
        
        expect(count).toBe(2); // agent1, agent3 are online
      });

      it('should return 0 for room with no online users', async () => {
        // すべてをオフラインにする
        await presenceStorage.updateUserStatus('util-room', 'agent1', 'offline');
        await presenceStorage.updateUserStatus('util-room', 'agent3', 'offline');
        
        const count = await presenceStorage.getOnlineUsersCount('util-room');
        
        expect(count).toBe(0);
      });
    });

    describe('incrementUserMessageCount', () => {
      it('should increment user message count', async () => {
        await presenceStorage.incrementUserMessageCount('util-room', 'agent1');
        await presenceStorage.incrementUserMessageCount('util-room', 'agent1');

        const presenceData = await presenceStorage.readPresence('util-room');
        expect(presenceData.users['agent1'].messageCount).toBe(2);
      });

      it('should throw error for non-existing user', async () => {
        await expect(
          presenceStorage.incrementUserMessageCount('util-room', 'non-existing')
        ).rejects.toThrow(FileNotFoundError);
      });
    });

    describe('clearRoomPresence', () => {
      it('should clear all users from room', async () => {
        await presenceStorage.clearRoomPresence('util-room');

        const presenceData = await presenceStorage.readPresence('util-room');
        expect(presenceData.users).toEqual({});
      });
    });

    describe('getAllUsersInRoom', () => {
      it('should return all users with their data', async () => {
        const allUsers = await presenceStorage.getAllUsersInRoom('util-room');
        
        expect(Object.keys(allUsers)).toEqual(['agent1', 'agent2', 'agent3']);
        expect(allUsers['agent1'].status).toBe('online');
        expect(allUsers['agent2'].status).toBe('offline');
        expect(allUsers['agent3'].status).toBe('online');
      });
    });
  });

  describe('error handling', () => {
    it('should handle file system errors gracefully', async () => {
      // ファイルシステムエラーをシミュレート - writeFile でエラーを発生させる
      const originalWriteFile = vol.promises.writeFile;
      vol.promises.writeFile = vi.fn().mockRejectedValue(new Error('Filesystem error'));

      await expect(presenceStorage.readPresence('error-room')).rejects.toThrow(StorageError);

      // 元の関数を復元
      vol.promises.writeFile = originalWriteFile;
    });

    it('should handle JSON parse errors', async () => {
      // 不正なJSONファイルを作成
      vol.fromJSON({
        [`${testDataDir}/rooms/bad-room/presence.json`]: 'invalid json'
      });

      await expect(presenceStorage.readPresence('bad-room')).rejects.toThrow(StorageError);
    });
  });
});