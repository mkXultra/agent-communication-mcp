import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol, fs } from 'memfs';
import { ManagementService } from '../../../src/features/management/ManagementService';
import { DataScanner } from '../../../src/features/management/DataScanner';
import { StatsCollector } from '../../../src/features/management/StatsCollector';

// Mock fs with memfs
vi.mock('fs', () => fs);
vi.mock('fs/promises', () => fs.promises);

describe('Management Statistics Accuracy Verification', () => {
  let managementService: ManagementService;
  let dataScanner: DataScanner;
  let statsCollector: StatsCollector;

  beforeEach(() => {
    vol.reset();
    managementService = new ManagementService('./test-data');
    dataScanner = new DataScanner('./test-data');
    statsCollector = new StatsCollector('./test-data');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Directory Scanning Accuracy', () => {
    it('should accurately count messages and online users across multiple rooms', async () => {
      // Create test data with known quantities
      vol.fromJSON({
        'test-data/rooms.json': JSON.stringify({
          rooms: {
            'room-1': { 
              createdAt: '2024-01-01T00:00:00.000Z',
              userCount: 3, 
              messageCount: 5,
              description: 'Test room 1'
            },
            'room-2': { 
              createdAt: '2024-01-02T00:00:00.000Z',
              userCount: 2, 
              messageCount: 3,
              description: 'Test room 2'
            },
            'empty-room': {
              createdAt: '2024-01-03T00:00:00.000Z',
              userCount: 0,
              messageCount: 0,
              description: 'Empty room'
            }
          }
        }),
        // Room 1: 5 messages, 2 online users
        'test-data/rooms/room-1/messages.jsonl': [
          '{"id":"msg1","agentName":"alice","message":"Hello","timestamp":"2024-01-01T10:00:00.000Z"}',
          '{"id":"msg2","agentName":"bob","message":"Hi","timestamp":"2024-01-01T10:01:00.000Z"}',
          '{"id":"msg3","agentName":"alice","message":"How are you?","timestamp":"2024-01-01T10:02:00.000Z"}',
          '{"id":"msg4","agentName":"charlie","message":"Fine","timestamp":"2024-01-01T10:03:00.000Z"}',
          '{"id":"msg5","agentName":"alice","message":"Great!","timestamp":"2024-01-01T10:04:00.000Z"}'
        ].join('\n'),
        'test-data/rooms/room-1/presence.json': JSON.stringify({
          alice: { online: true, lastSeen: '2024-01-01T10:04:00.000Z' },
          bob: { online: false, lastSeen: '2024-01-01T09:30:00.000Z' },
          charlie: { online: true, lastSeen: '2024-01-01T10:03:00.000Z' }
        }),
        // Room 2: 3 messages, 1 online user
        'test-data/rooms/room-2/messages.jsonl': [
          '{"id":"msg1","agentName":"user1","message":"Message 1","timestamp":"2024-01-02T10:00:00.000Z"}',
          '{"id":"msg2","agentName":"user2","message":"Message 2","timestamp":"2024-01-02T10:01:00.000Z"}',
          '{"id":"msg3","agentName":"user1","message":"Message 3","timestamp":"2024-01-02T10:02:00.000Z"}'
        ].join('\n'),
        'test-data/rooms/room-2/presence.json': JSON.stringify({
          user1: { online: true, lastSeen: '2024-01-02T10:02:00.000Z' },
          user2: { online: false, lastSeen: '2024-01-02T09:30:00.000Z' }
        }),
        // Empty room: 0 messages, 0 online users
        'test-data/rooms/empty-room/messages.jsonl': '',
        'test-data/rooms/empty-room/presence.json': JSON.stringify({})
      });

      const systemStatus = await managementService.getStatus();

      // Verify overall statistics
      expect(systemStatus.totalRooms).toBe(3);
      expect(systemStatus.totalMessages).toBe(8); // 5 + 3 + 0
      expect(systemStatus.totalOnlineUsers).toBe(3); // 2 + 1 + 0

      // Verify per-room statistics
      const room1Stats = systemStatus.rooms.find(r => r.name === 'room-1');
      expect(room1Stats).toMatchObject({
        name: 'room-1',
        totalMessages: 5,
        onlineUsers: 2,
        storageSize: expect.any(Number)
      });

      const room2Stats = systemStatus.rooms.find(r => r.name === 'room-2');
      expect(room2Stats).toMatchObject({
        name: 'room-2',
        totalMessages: 3,
        onlineUsers: 1,
        storageSize: expect.any(Number)
      });

      const emptyRoomStats = systemStatus.rooms.find(r => r.name === 'empty-room');
      expect(emptyRoomStats).toMatchObject({
        name: 'empty-room',
        totalMessages: 0,
        onlineUsers: 0,
        storageSize: 0
      });
    });

    it('should handle rooms.json structure correctly', async () => {
      vol.fromJSON({
        'test-data/rooms.json': JSON.stringify({
          rooms: {
            'test-room': { 
              createdAt: '2024-01-01T00:00:00.000Z',
              userCount: 1, 
              messageCount: 2,
              description: 'Test room'
            }
          }
        }),
        'test-data/rooms/test-room/messages.jsonl': [
          '{"id":"msg1","agentName":"agent","message":"Hello","timestamp":"2024-01-01T10:00:00.000Z"}',
          '{"id":"msg2","agentName":"agent","message":"World","timestamp":"2024-01-01T10:01:00.000Z"}'
        ].join('\n'),
        'test-data/rooms/test-room/presence.json': JSON.stringify({
          agent: { online: true, lastSeen: '2024-01-01T10:01:00.000Z' }
        })
      });

      const rooms = await dataScanner.getAllRooms();
      expect(rooms).toEqual(['test-room']);

      const systemStatus = await managementService.getStatus();
      expect(systemStatus.rooms).toHaveLength(1);
      expect(systemStatus.rooms[0].name).toBe('test-room');
    });
  });

  describe('Message Clearing Verification', () => {
    it('should require confirm=true and accurately count cleared messages', async () => {
      vol.fromJSON({
        'test-data/rooms.json': JSON.stringify({
          rooms: {
            'test-room': { 
              createdAt: '2024-01-01T00:00:00.000Z',
              userCount: 1, 
              messageCount: 3,
              description: 'Test room'
            }
          }
        }),
        'test-data/rooms/test-room/messages.jsonl': [
          '{"id":"msg1","agentName":"agent","message":"Message 1","timestamp":"2024-01-01T10:00:00.000Z"}',
          '{"id":"msg2","agentName":"agent","message":"Message 2","timestamp":"2024-01-01T10:01:00.000Z"}',
          '{"id":"msg3","agentName":"agent","message":"Message 3","timestamp":"2024-01-01T10:02:00.000Z"}'
        ].join('\n'),
        'test-data/rooms/test-room/presence.json': JSON.stringify({
          agent: { online: true, lastSeen: '2024-01-01T10:02:00.000Z' }
        })
      });

      // Should reject when confirm=false
      await expect(managementService.clearRoomMessages('test-room', false))
        .rejects.toThrow('Confirmation required');

      // Should succeed when confirm=true and return accurate count
      const result = await managementService.clearRoomMessages('test-room', true);
      expect(result).toMatchObject({
        success: true,
        roomName: 'test-room',
        clearedCount: 3
      });

      // Verify messages are actually cleared
      const postClearStatus = await managementService.getRoomStatistics('test-room');
      expect(postClearStatus.totalMessages).toBe(0);
    });
  });

  describe('Storage Size Calculation', () => {
    it('should calculate storage sizes accurately', async () => {
      const testContent = '{"id":"msg1","agentName":"agent","message":"Hello World","timestamp":"2024-01-01T10:00:00.000Z"}';
      const expectedSize = Buffer.from(testContent).length;

      vol.fromJSON({
        'test-data/rooms.json': JSON.stringify({
          rooms: {
            'storage-test': { 
              createdAt: '2024-01-01T00:00:00.000Z',
              userCount: 1, 
              messageCount: 1,
              description: 'Storage test room'
            }
          }
        }),
        'test-data/rooms/storage-test/messages.jsonl': testContent,
        'test-data/rooms/storage-test/presence.json': JSON.stringify({
          agent: { online: true, lastSeen: '2024-01-01T10:00:00.000Z' }
        })
      });

      const roomStats = await managementService.getRoomStatistics('storage-test');
      expect(roomStats.storageSize).toBe(expectedSize);
    });
  });

  describe('Error Handling Verification', () => {
    it('should handle non-existent rooms correctly', async () => {
      vol.fromJSON({
        'test-data/rooms.json': JSON.stringify({
          rooms: {}
        })
      });

      await expect(managementService.getRoomStatistics('non-existent'))
        .rejects.toThrow('Room \'non-existent\' not found');

      await expect(managementService.clearRoomMessages('non-existent', true))
        .rejects.toThrow('Room \'non-existent\' not found');
    });

    it('should handle missing files gracefully', async () => {
      vol.fromJSON({
        'test-data/rooms.json': JSON.stringify({
          rooms: {
            'incomplete-room': { 
              createdAt: '2024-01-01T00:00:00.000Z',
              userCount: 0, 
              messageCount: 0,
              description: 'Incomplete room'
            }
          }
        })
        // No messages.jsonl or presence.json files
      });

      const roomStats = await managementService.getRoomStatistics('incomplete-room');
      expect(roomStats).toMatchObject({
        name: 'incomplete-room',
        totalMessages: 0,
        onlineUsers: 0,
        storageSize: 0
      });
    });
  });

  describe('Performance Verification', () => {
    it('should handle large datasets efficiently', async () => {
      // Create a large dataset
      const largeMessageContent = new Array(1000).fill(0)
        .map((_, i) => `{"id":"msg-${i}","agentName":"agent${i % 10}","message":"Message ${i}","timestamp":"2024-01-01T10:${String(i % 60).padStart(2, '0')}:00.000Z"}`)
        .join('\n');

      vol.fromJSON({
        'test-data/rooms.json': JSON.stringify({
          rooms: {
            'large-room': { 
              createdAt: '2024-01-01T00:00:00.000Z',
              userCount: 10, 
              messageCount: 1000,
              description: 'Large room'
            }
          }
        }),
        'test-data/rooms/large-room/messages.jsonl': largeMessageContent,
        'test-data/rooms/large-room/presence.json': JSON.stringify({
          ...Array.from({ length: 10 }, (_, i) => ({
            [`agent${i}`]: { online: i % 2 === 0, lastSeen: '2024-01-01T10:00:00.000Z' }
          })).reduce((acc, curr) => ({ ...acc, ...curr }), {})
        })
      });

      const startTime = Date.now();
      const roomStats = await managementService.getRoomStatistics('large-room');
      const duration = Date.now() - startTime;

      expect(roomStats.totalMessages).toBe(1000);
      expect(roomStats.onlineUsers).toBe(5); // Half of 10 agents
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });
  });
});