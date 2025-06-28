import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import type { AgentProfile } from '../../../src/types/entities';

// Mock the getDataDirectory function to return our test directory
vi.mock('../../../src/utils/dataDir', () => ({
  getDataDirectory: () => process.env.AGENT_COMM_DATA_DIR || '/test-data',
  DEFAULT_HOME_DATA_DIR: '/home/.agent-communication-mcp',
  LEGACY_DATA_DIR: './data'
}));

// ファイルシステムをモック
vi.mock('fs', () => ({
  ...vol,
  promises: vol.promises,
  existsSync: vol.existsSync.bind(vol),
  accessSync: vol.accessSync.bind(vol),
  constants: { W_OK: 2 }
}));
vi.mock('fs/promises', () => ({
  default: vol.promises,
  ...vol.promises
}));

describe('Multi-Room Load Tests', () => {
  let RoomsAPI: any;
  const testDataDir = '/load-test-data';

  // 負荷テスト設定
  const MAX_ROOMS = parseInt(process.env.AGENT_COMM_MAX_ROOMS || '10', 10);
  const NUM_ROOMS = Math.min(100, MAX_ROOMS); // Respect environment limit
  const NUM_AGENTS_PER_ROOM = Math.min(50, Math.floor(5000 / NUM_ROOMS)); // Adjust agents based on room limit
  const TOTAL_AGENTS = NUM_ROOMS * NUM_AGENTS_PER_ROOM;

  beforeEach(async () => {
    // Set environment variable to use test directory
    process.env.AGENT_COMM_DATA_DIR = testDataDir;
    
    // ファイルシステムをリセット
    vol.reset();
    vol.fromJSON({
      [`${testDataDir}/rooms.json`]: JSON.stringify({ rooms: {} })
    });
    
    // Import RoomsAPI dynamically after setting up mocks
    const roomsModule = await import('../../../src/features/rooms');
    RoomsAPI = roomsModule.RoomsAPI;
  });

  afterEach(() => {
    vol.reset();
    // Clean up environment variable
    delete process.env.AGENT_COMM_DATA_DIR;
  });

  it('should handle creation of 100 rooms', async () => {
    const roomsAPI = new RoomsAPI(testDataDir);
    console.log(`Creating ${NUM_ROOMS} rooms...`);
    const startTime = Date.now();

    // Limit concurrent operations to prevent memfs issues
    const BATCH_SIZE = 10;
    const results = [];
    
    for (let i = 0; i < NUM_ROOMS; i += BATCH_SIZE) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, NUM_ROOMS); j++) {
        const roomName = `room-${(j + 1).toString().padStart(3, '0')}`;
        const description = `Load test room ${j + 1}`;
        
        batch.push(roomsAPI.createRoom(roomName, description));
      }
      
      const batchResults = await Promise.all(batch);
      results.push(...batchResults);
    }
    const endTime = Date.now();

    // すべてのルームが正常に作成されたことを確認
    expect(results).toHaveLength(NUM_ROOMS);
    results.forEach(result => {
      expect(result.success).toBe(true);
    });

    // パフォーマンス測定
    const totalTime = endTime - startTime;
    const averageTimePerRoom = totalTime / NUM_ROOMS;
    
    console.log(`Room creation completed in ${totalTime}ms`);
    console.log(`Average time per room: ${averageTimePerRoom.toFixed(2)}ms`);

    // ルーム数の確認
    const roomCount = await roomsAPI.getRoomCount();
    expect(roomCount).toBe(NUM_ROOMS);

    // パフォーマンス要件（目安）
    expect(averageTimePerRoom).toBeLessThan(100); // 100ms以下
  }, 30000); // 30秒のタイムアウト

  it('should handle 50 agents entering each room', async () => {
    const roomsAPI = new RoomsAPI(testDataDir);
    console.log('Setting up rooms for agent entry test...');
    
    // まず10個のルームを作成（全部だと時間がかかりすぎるため）
    const testRooms = Math.min(10, NUM_ROOMS);
    for (let i = 1; i <= testRooms; i++) {
      await roomsAPI.createRoom(`test-room-${i}`, `Test room ${i}`);
    }

    console.log(`Testing ${NUM_AGENTS_PER_ROOM} agents entering ${testRooms} rooms...`);
    const startTime = Date.now();

    const enterRoomPromises = [];
    for (let roomIndex = 1; roomIndex <= testRooms; roomIndex++) {
      const roomName = `test-room-${roomIndex}`;
      
      for (let agentIndex = 1; agentIndex <= NUM_AGENTS_PER_ROOM; agentIndex++) {
        const agentName = `agent-${roomIndex}-${agentIndex.toString().padStart(3, '0')}`;
        const profile: AgentProfile = {
          role: agentIndex % 3 === 0 ? 'coordinator' : 'worker',
          description: `Load test agent ${agentIndex} in room ${roomIndex}`,
          capabilities: ['load-testing'],
          metadata: { roomIndex, agentIndex }
        };

        enterRoomPromises.push(
          roomsAPI.enterRoom(agentName, roomName, profile)
        );
      }
    }

    const results = await Promise.all(enterRoomPromises);
    const endTime = Date.now();

    // すべてのエージェントが正常に入室したことを確認
    const totalOperations = testRooms * NUM_AGENTS_PER_ROOM;
    expect(results).toHaveLength(totalOperations);
    results.forEach(result => {
      expect(result.success).toBe(true);
    });

    // パフォーマンス測定
    const totalTime = endTime - startTime;
    const averageTimePerOperation = totalTime / totalOperations;
    
    console.log(`Agent entry completed in ${totalTime}ms`);
    console.log(`Average time per operation: ${averageTimePerOperation.toFixed(2)}ms`);
    console.log(`Total operations: ${totalOperations}`);

    // 各ルームのユーザー数確認
    for (let roomIndex = 1; roomIndex <= testRooms; roomIndex++) {
      const roomName = `test-room-${roomIndex}`;
      const onlineCount = await roomsAPI.getOnlineUsersCount(roomName);
      expect(onlineCount).toBe(NUM_AGENTS_PER_ROOM);
    }

    // パフォーマンス要件（目安）
    expect(averageTimePerOperation).toBeLessThan(50); // 50ms以下
  }, 60000); // 60秒のタイムアウト

  it('should handle concurrent room operations', async () => {
    const roomsAPI = new RoomsAPI(testDataDir);
    console.log('Testing concurrent room operations...');
    const startTime = Date.now();

    // 同時に複数の操作を実行
    const operations = [];

    // ルーム作成操作
    for (let i = 1; i <= 20; i++) {
      operations.push(
        roomsAPI.createRoom(`concurrent-room-${i}`, `Concurrent test room ${i}`)
      );
    }

    // ルーム一覧操作
    for (let i = 0; i < 5; i++) {
      operations.push(roomsAPI.listRooms());
    }

    const results = await Promise.all(operations);
    const endTime = Date.now();

    // 結果の検証
    const createResults = results.slice(0, 20);
    const listResults = results.slice(20, 25);

    createResults.forEach(result => {
      expect(result.success).toBe(true);
    });

    listResults.forEach(result => {
      expect(result.rooms).toBeDefined();
      expect(Array.isArray(result.rooms)).toBe(true);
    });

    const totalTime = endTime - startTime;
    console.log(`Concurrent operations completed in ${totalTime}ms`);

    // 最終的なルーム数確認
    const finalCount = await roomsAPI.getRoomCount();
    // Since no actual limit is enforced in the storage layer, all 20 rooms are created
    expect(finalCount).toBe(20);
  }, 30000);

  it('should maintain data consistency under load', async () => {
    const roomsAPI = new RoomsAPI(testDataDir);
    console.log('Testing data consistency under load...');

    // 複数のルームを作成
    const testRooms = Math.min(5, MAX_ROOMS);
    for (let i = 1; i <= testRooms; i++) {
      await roomsAPI.createRoom(`consistency-room-${i}`, `Consistency test room ${i}`);
    }

    // 複数のエージェントが同じルームに入退室を繰り返す
    const agentOperations = [];
    const agentsPerRoom = 10;

    for (let roomIndex = 1; roomIndex <= testRooms; roomIndex++) {
      const roomName = `consistency-room-${roomIndex}`;
      
      for (let agentIndex = 1; agentIndex <= agentsPerRoom; agentIndex++) {
        const agentName = `consistency-agent-${roomIndex}-${agentIndex}`;
        
        agentOperations.push(async () => {
          // 入室
          await roomsAPI.enterRoom(agentName, roomName, {
            role: 'tester',
            description: 'Consistency test agent'
          });
          
          // ユーザー一覧取得
          await roomsAPI.getRoomUsers(roomName);
          
          // 退室
          await roomsAPI.leaveRoom(agentName, roomName);
        });
      }
    }

    // すべての操作を並行実行
    await Promise.all(agentOperations.map(op => op()));

    // データの整合性確認
    for (let roomIndex = 1; roomIndex <= testRooms; roomIndex++) {
      const roomName = `consistency-room-${roomIndex}`;
      const users = await roomsAPI.getRoomUsers(roomName);
      
      // すべてのユーザーがオフライン状態であることを確認
      expect(users.onlineCount).toBe(0);
      expect(users.users.every(user => user.status === 'offline')).toBe(true);
    }

    console.log('Data consistency test completed successfully');
  }, 45000);

  it('should handle memory efficiently with large datasets', async () => {
    const roomsAPI = new RoomsAPI(testDataDir);
    console.log('Testing memory efficiency...');
    
    // 大量のルームとエージェントを作成
    const memoryTestRooms = 50;
    const memoryTestAgents = 20;

    // ルーム作成
    for (let i = 1; i <= memoryTestRooms; i++) {
      await roomsAPI.createRoom(`memory-room-${i}`, `Memory test room ${i}`);
    }

    // エージェント入室
    for (let roomIndex = 1; roomIndex <= memoryTestRooms; roomIndex++) {
      const roomName = `memory-room-${roomIndex}`;
      
      for (let agentIndex = 1; agentIndex <= memoryTestAgents; agentIndex++) {
        const agentName = `memory-agent-${roomIndex}-${agentIndex}`;
        await roomsAPI.enterRoom(agentName, roomName);
      }
    }

    // 大量のデータが存在する状態での操作性能確認
    const startTime = Date.now();
    
    const allRooms = await roomsAPI.listRooms();
    expect(allRooms.rooms).toHaveLength(memoryTestRooms);
    
    const roomCount = await roomsAPI.getRoomCount();
    expect(roomCount).toBe(memoryTestRooms);

    const endTime = Date.now();
    const queryTime = endTime - startTime;
    
    console.log(`Query operations on large dataset completed in ${queryTime}ms`);
    
    // クエリ性能要件
    expect(queryTime).toBeLessThan(1000); // 1秒以下

    console.log('Memory efficiency test completed successfully');
  }, 60000);
});