import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { RoomStorage } from '../../../src/features/rooms/room/RoomStorage';
import { StorageError } from '../../../src/errors';
import type { RoomsData, RoomData } from '../../../src/features/rooms/types/rooms.types';

// ファイルシステムをモック
vi.mock('fs/promises', () => ({
  default: vol.promises,
  ...vol.promises
}));

describe('RoomStorage', () => {
  let roomStorage: RoomStorage;
  const testDataDir = '/test-storage';

  beforeEach(() => {
    // ファイルシステムをリセット
    vol.reset();
    vol.fromJSON({}, testDataDir);
    
    roomStorage = new RoomStorage(testDataDir);
  });

  afterEach(() => {
    vol.reset();
  });

  describe('readRooms', () => {
    it('should return empty rooms data when file does not exist', async () => {
      const result = await roomStorage.readRooms();
      
      expect(result).toEqual({ rooms: {} });
    });

    it('should read existing rooms data', async () => {
      const roomsData: RoomsData = {
        rooms: {
          'test-room': {
            description: 'Test room',
            createdAt: '2024-01-20T10:00:00Z',
            messageCount: 0,
            userCount: 0
          }
        }
      };

      // ファイルを事前に作成
      vol.fromJSON({
        [`${testDataDir}/rooms.json`]: JSON.stringify(roomsData, null, 2)
      });

      const result = await roomStorage.readRooms();
      
      expect(result).toEqual(roomsData);
    });

    it('should handle JSON parse errors', async () => {
      // 不正なJSONファイルを作成
      vol.fromJSON({
        [`${testDataDir}/rooms.json`]: 'invalid json'
      });

      await expect(roomStorage.readRooms()).rejects.toThrow(StorageError);
    });
  });

  describe('writeRooms', () => {
    it('should write rooms data to file', async () => {
      const roomsData: RoomsData = {
        rooms: {
          'new-room': {
            description: 'New test room',
            createdAt: '2024-01-20T11:00:00Z',
            messageCount: 0,
            userCount: 0
          }
        }
      };

      await roomStorage.writeRooms(roomsData);

      // ファイルが正しく書き込まれたか確認
      const writtenData = await roomStorage.readRooms();
      expect(writtenData).toEqual(roomsData);
    });

    it('should create directory if it does not exist', async () => {
      vol.reset(); // ディレクトリを削除
      
      const roomsData: RoomsData = { rooms: {} };
      
      await expect(roomStorage.writeRooms(roomsData)).resolves.not.toThrow();
    });
  });

  describe('createRoom', () => {
    it('should create a new room', async () => {
      const roomName = 'new-room';
      const description = 'New room description';

      await roomStorage.createRoom(roomName, description);

      const roomsData = await roomStorage.readRooms();
      expect(roomsData.rooms[roomName]).toMatchObject({
        description,
        messageCount: 0,
        userCount: 0
      });
      expect(roomsData.rooms[roomName].createdAt).toBeDefined();
    });

    it('should create room without description', async () => {
      const roomName = 'simple-room';

      await roomStorage.createRoom(roomName);

      const roomsData = await roomStorage.readRooms();
      expect(roomsData.rooms[roomName]).toMatchObject({
        description: undefined,
        messageCount: 0,
        userCount: 0
      });
    });
  });

  describe('roomExists', () => {
    beforeEach(async () => {
      await roomStorage.createRoom('existing-room', 'Existing room');
    });

    it('should return true for existing room', async () => {
      const exists = await roomStorage.roomExists('existing-room');
      
      expect(exists).toBe(true);
    });

    it('should return false for non-existing room', async () => {
      const exists = await roomStorage.roomExists('non-existing-room');
      
      expect(exists).toBe(false);
    });
  });

  describe('getRoomData', () => {
    beforeEach(async () => {
      await roomStorage.createRoom('test-room', 'Test room');
    });

    it('should return room data for existing room', async () => {
      const roomData = await roomStorage.getRoomData('test-room');
      
      expect(roomData).toMatchObject({
        description: 'Test room',
        messageCount: 0,
        userCount: 0
      });
      expect(roomData?.createdAt).toBeDefined();
    });

    it('should return null for non-existing room', async () => {
      const roomData = await roomStorage.getRoomData('non-existing-room');
      
      expect(roomData).toBeNull();
    });
  });

  describe('updateRoomUserCount', () => {
    beforeEach(async () => {
      await roomStorage.createRoom('update-room', 'Update test room');
    });

    it('should update user count for existing room', async () => {
      await roomStorage.updateRoomUserCount('update-room', 5);

      const roomData = await roomStorage.getRoomData('update-room');
      expect(roomData?.userCount).toBe(5);
    });

    it('should throw error for non-existing room', async () => {
      await expect(
        roomStorage.updateRoomUserCount('non-existing-room', 5)
      ).rejects.toThrow();
    });
  });

  describe('utility methods', () => {
    beforeEach(async () => {
      await roomStorage.createRoom('room1', 'Room 1');
      await roomStorage.createRoom('room2', 'Room 2');
      await roomStorage.createRoom('room3', 'Room 3');
    });

    describe('getAllRoomNames', () => {
      it('should return all room names', async () => {
        const roomNames = await roomStorage.getAllRoomNames();
        
        expect(roomNames.sort()).toEqual(['room1', 'room2', 'room3']);
      });

      it('should return empty array when no rooms exist', async () => {
        await roomStorage.clearAllRooms();
        
        const roomNames = await roomStorage.getAllRoomNames();
        
        expect(roomNames).toEqual([]);
      });
    });

    describe('clearAllRooms', () => {
      it('should clear all rooms', async () => {
        await roomStorage.clearAllRooms();

        const roomsData = await roomStorage.readRooms();
        expect(roomsData.rooms).toEqual({});
      });
    });
  });

  describe('error handling', () => {
    it('should handle file system errors gracefully', async () => {
      // ファイルシステムエラーをシミュレート
      const originalMkdir = vol.promises.mkdir;
      vol.promises.mkdir = vi.fn().mockRejectedValue(new Error('Filesystem error'));

      await expect(roomStorage.readRooms()).rejects.toThrow(StorageError);

      // 元の関数を復元
      vol.promises.mkdir = originalMkdir;
    });
  });
});