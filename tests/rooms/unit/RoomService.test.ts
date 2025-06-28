import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { RoomService } from '../../../src/features/rooms/room/RoomService';
import { RoomAlreadyExistsError, ValidationError } from '../../../src/errors';
import type { CreateRoomResult, ListRoomsResult } from '../../../src/features/rooms/types/rooms.types';

// ファイルシステムをモック
vi.mock('fs/promises', () => ({
  default: vol.promises,
  ...vol.promises
}));

// LockServiceをモック
vi.mock('../../../src/services/LockService', () => ({
  LockService: vi.fn().mockImplementation(() => ({
    withLock: vi.fn().mockImplementation(async (path: string, fn: () => Promise<any>) => {
      return await fn();
    })
  }))
}));

describe('RoomService', () => {
  let roomService: RoomService;
  const testDataDir = '/test-data';

  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();
    
    // ファイルシステムをリセット
    vol.reset();
    vol.fromJSON({}, testDataDir);
    
    roomService = new RoomService(testDataDir);
  });

  afterEach(() => {
    vol.reset();
  });

  describe('createRoom', () => {
    it('should create a new room successfully', async () => {
      const roomName = 'test-room';
      const description = 'Test room description';

      const result: CreateRoomResult = await roomService.createRoom(roomName, description);

      expect(result).toEqual({
        success: true,
        roomName: 'test-room',
        message: "Room 'test-room' created successfully"
      });

      // ルームが実際に作成されているかチェック
      const exists = await roomService.roomExists(roomName);
      expect(exists).toBe(true);
    });

    it('should create a room without description', async () => {
      const roomName = 'test-room-no-desc';

      const result: CreateRoomResult = await roomService.createRoom(roomName);

      expect(result).toEqual({
        success: true,
        roomName: 'test-room-no-desc',
        message: "Room 'test-room-no-desc' created successfully"
      });

      const exists = await roomService.roomExists(roomName);
      expect(exists).toBe(true);
    });

    it('should throw RoomAlreadyExistsError when room already exists', async () => {
      const roomName = 'existing-room';
      
      // 最初にルームを作成
      await roomService.createRoom(roomName);
      
      // 同じ名前で再度作成を試みる
      await expect(roomService.createRoom(roomName)).rejects.toThrow(RoomAlreadyExistsError);
    });

    it('should validate room name format', async () => {
      const invalidNames = [
        '', // 空文字
        'room with spaces', // スペース
        'room@invalid', // 無効文字
        'room/invalid', // スラッシュ
        'a'.repeat(51), // 長すぎる
      ];

      for (const invalidName of invalidNames) {
        await expect(roomService.createRoom(invalidName)).rejects.toThrow(ValidationError);
      }
    });

    it('should validate description length', async () => {
      const longDescription = 'a'.repeat(201); // 201文字

      await expect(roomService.createRoom('test-room', longDescription)).rejects.toThrow(ValidationError);
    });

    it('should accept valid room names', async () => {
      const validNames = [
        'test-room',
        'test_room',
        'TestRoom123',
        'room-with-dashes',
        'room_with_underscores',
        'a'.repeat(50), // 最大長
      ];

      for (const validName of validNames) {
        await expect(roomService.createRoom(validName)).resolves.not.toThrow();
      }
    });
  });

  describe('listRooms', () => {
    beforeEach(async () => {
      // テスト用のルームを作成
      await roomService.createRoom('room1', 'First room');
      await roomService.createRoom('room2', 'Second room');
      await roomService.createRoom('room3'); // 説明なし
    });

    it('should list all rooms', async () => {
      const result: ListRoomsResult = await roomService.listRooms();

      expect(result.rooms).toHaveLength(3);
      expect(result.rooms.map(r => r.name).sort()).toEqual(['room1', 'room2', 'room3']);
      
      // 各ルームの基本情報をチェック
      const room1 = result.rooms.find(r => r.name === 'room1');
      expect(room1).toMatchObject({
        name: 'room1',
        description: 'First room',
        userCount: 0,
        messageCount: 0
      });
    });

    it('should return empty list when no rooms exist', async () => {
      await roomService.clearAllRooms();
      
      const result: ListRoomsResult = await roomService.listRooms();
      
      expect(result.rooms).toHaveLength(0);
    });

    it('should filter rooms by agent when agentName is provided', async () => {
      // この機能はPresenceServiceと連携するため、基本的な動作のみテスト
      const result: ListRoomsResult = await roomService.listRooms('test-agent');

      expect(result.rooms).toHaveLength(3);
      // isJoinedプロパティが含まれていることを確認
      result.rooms.forEach(room => {
        expect(room).toHaveProperty('isJoined');
        expect(room.isJoined).toBe(false); // プレゼンスデータがないため
      });
    });
  });

  describe('roomExists', () => {
    it('should return true for existing room', async () => {
      await roomService.createRoom('existing-room');
      
      const exists = await roomService.roomExists('existing-room');
      
      expect(exists).toBe(true);
    });

    it('should return false for non-existing room', async () => {
      const exists = await roomService.roomExists('non-existing-room');
      
      expect(exists).toBe(false);
    });
  });

  describe('getRoomData', () => {
    it('should return room data for existing room', async () => {
      const roomName = 'test-room';
      const description = 'Test description';
      
      await roomService.createRoom(roomName, description);
      
      const roomData = await roomService.getRoomData(roomName);
      
      expect(roomData).toMatchObject({
        description: 'Test description',
        messageCount: 0,
        userCount: 0
      });
      expect(roomData?.createdAt).toBeDefined();
    });

    it('should return null for non-existing room', async () => {
      const roomData = await roomService.getRoomData('non-existing-room');
      
      expect(roomData).toBeNull();
    });
  });

  describe('getAllRoomNames', () => {
    it('should return all room names', async () => {
      await roomService.createRoom('room-a');
      await roomService.createRoom('room-b');
      await roomService.createRoom('room-c');
      
      const roomNames = await roomService.getAllRoomNames();
      
      expect(roomNames.sort()).toEqual(['room-a', 'room-b', 'room-c']);
    });

    it('should return empty array when no rooms exist', async () => {
      const roomNames = await roomService.getAllRoomNames();
      
      expect(roomNames).toEqual([]);
    });
  });

  describe('getRoomCount', () => {
    it('should return correct room count', async () => {
      await roomService.createRoom('room1');
      await roomService.createRoom('room2');
      
      const count = await roomService.getRoomCount();
      
      expect(count).toBe(2);
    });

    it('should return 0 when no rooms exist', async () => {
      const count = await roomService.getRoomCount();
      
      expect(count).toBe(0);
    });
  });
});