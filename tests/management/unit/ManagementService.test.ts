import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fs, vol } from 'memfs';
import type { IManagementAPI } from '../../../src/features/management';

// Mock the fs module with memfs for testing
vi.mock('fs', () => fs);
vi.mock('fs/promises', () => fs.promises);

describe('ManagementService', () => {
  let managementService: IManagementAPI;

  beforeEach(() => {
    // Reset the virtual file system
    vol.reset();
    
    // Create test directory structure
    vol.fromJSON({
      'data/rooms.json': JSON.stringify({
        rooms: ['general', 'dev-team', 'empty-room']
      }),
      'data/rooms/general/messages.jsonl': 
        '{"id":"msg1","agentName":"agent1","message":"Hello","timestamp":"2024-01-01T10:00:00.000Z"}\n' +
        '{"id":"msg2","agentName":"agent2","message":"Hi there","timestamp":"2024-01-01T10:01:00.000Z"}\n',
      'data/rooms/general/presence.json': JSON.stringify({
        users: {
          agent1: { status: 'online', lastSeen: '2024-01-01T10:00:00.000Z' },
          agent2: { status: 'offline', lastSeen: '2024-01-01T09:00:00.000Z' },
          agent3: { status: 'online', lastSeen: '2024-01-01T10:00:00.000Z' }
        }
      }),
      'data/rooms/dev-team/messages.jsonl': 
        '{"id":"msg3","agentName":"dev1","message":"Code review","timestamp":"2024-01-02T10:00:00.000Z"}\n',
      'data/rooms/dev-team/presence.json': JSON.stringify({
        users: {
          dev1: { status: 'online', lastSeen: '2024-01-02T10:00:00.000Z' },
          dev2: { status: 'offline', lastSeen: '2024-01-02T09:00:00.000Z' }
        }
      }),
      'data/rooms/empty-room/messages.jsonl': '',
      'data/rooms/empty-room/presence.json': JSON.stringify({
        users: {}
      })
    });

    // Import ManagementService using ES modules
    const { ManagementService } = await import('../../../src/features/management');
    managementService = new ManagementService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getStatus', () => {
    it('should return system-wide statistics when no roomName provided', async () => {
      const result = await managementService.getStatus();
      
      expect(result).toMatchObject({
        rooms: expect.arrayContaining([
          {
            name: 'general',
            onlineUsers: 2,
            totalMessages: 2,
            storageSize: expect.any(Number)
          },
          {
            name: 'dev-team',
            onlineUsers: 1,
            totalMessages: 1,
            storageSize: expect.any(Number)
          },
          {
            name: 'empty-room',
            onlineUsers: 0,
            totalMessages: 0,
            storageSize: 0
          }
        ]),
        totalRooms: 3,
        totalOnlineUsers: 3,
        totalMessages: 3
      });
    });

    it('should return specific room statistics when roomName provided', async () => {
      const result = await managementService.getRoomStatistics('general');
      
      expect(result).toMatchObject({
        name: 'general',
        onlineUsers: 2,
        totalMessages: 2,
        storageSize: expect.any(Number)
      });
    });

    it('should handle empty room correctly', async () => {
      const result = await managementService.getRoomStatistics('empty-room');
      
      expect(result).toMatchObject({
        name: 'empty-room',
        onlineUsers: 0,
        totalMessages: 0,
        storageSize: 0
      });
    });

    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(
        managementService.getRoomStatistics('non-existent')
      ).rejects.toThrow('Room \'non-existent\' not found');
    });

    it('should calculate storage size correctly', async () => {
      const result = await managementService.getRoomStatistics('general');
      
      // The storage size should be the size of the messages.jsonl file
      const expectedSize = Buffer.from(
        '{"id":"msg1","agentName":"agent1","message":"Hello","timestamp":"2024-01-01T10:00:00.000Z"}\n' +
        '{"id":"msg2","agentName":"agent2","message":"Hi there","timestamp":"2024-01-01T10:01:00.000Z"}\n'
      ).length;
      
      expect(result.storageSize).toBe(expectedSize);
    });

    it('should handle missing presence.json file gracefully', async () => {
      // Remove presence file
      vol.fromJSON({
        'data/rooms/general/messages.jsonl': 
          '{"id":"msg1","agentName":"agent1","message":"Hello","timestamp":"2024-01-01T10:00:00.000Z"}\n'
      }, 'data/rooms/general');

      const result = await managementService.getRoomStatistics('general');
      
      expect(result.onlineUsers).toBe(0);
    });

    it('should handle missing messages.jsonl file gracefully', async () => {
      // Remove messages file
      vol.fromJSON({
        'data/rooms/general/presence.json': JSON.stringify({
          users: {
            agent1: { status: 'online', lastSeen: '2024-01-01T10:00:00.000Z' }
          }
        })
      }, 'data/rooms/general');

      const result = await managementService.getRoomStatistics('general');
      
      expect(result.totalMessages).toBe(0);
      expect(result.storageSize).toBe(0);
    });
  });

  describe('clearRoomMessages', () => {
    it('should require confirm=true to clear messages', async () => {
      await expect(
        managementService.clearRoomMessages('general', false)
      ).rejects.toThrow('Validation failed for field \'confirm\': Confirmation required');
    });

    it('should clear messages when confirm=true', async () => {
      const result = await managementService.clearRoomMessages('general', true);
      
      expect(result).toMatchObject({
        success: true,
        roomName: 'general',
        clearedCount: 2
      });
    });

    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(
        managementService.clearRoomMessages('non-existent', true)
      ).rejects.toThrow('Room \'non-existent\' not found');
    });

    it('should handle empty room clearing', async () => {
      const result = await managementService.clearRoomMessages('empty-room', true);
      
      expect(result).toMatchObject({
        success: true,
        roomName: 'empty-room',
        clearedCount: 0
      });
    });

    it('should update rooms.json after clearing messages', async () => {
      await managementService.clearRoomMessages('general', true);
      
      // Verify that the message count in rooms.json is updated
      const roomsData = JSON.parse(fs.readFileSync('data/rooms.json', 'utf8'));
      expect(roomsData.rooms.general.messageCount).toBe(0);
    });

    it('should actually remove messages from messages.jsonl file', async () => {
      await managementService.clearRoomMessages('general', true);
      
      // Verify that the messages file is cleared
      const messagesContent = fs.readFileSync('data/rooms/general/messages.jsonl', 'utf8');
      expect(messagesContent).toBe('');
    });

    it('should not affect other rooms when clearing one room', async () => {
      await managementService.clearRoomMessages('general', true);
      
      // Verify that dev-team messages are still there
      const devTeamMessages = fs.readFileSync('data/rooms/dev-team/messages.jsonl', 'utf8');
      expect(devTeamMessages).toContain('Code review');
      
      // dev-team should still exist in the rooms array
      const roomsData = JSON.parse(fs.readFileSync('data/rooms.json', 'utf8'));
      expect(roomsData.rooms).toContain('dev-team');
    });
  });

  describe('error handling', () => {
    it('should throw StorageError when rooms.json is corrupted', async () => {
      vol.fromJSON({
        'data/rooms.json': 'invalid json'
      });

      await expect(
        managementService.getStatus()
      ).rejects.toThrow('StorageError');
    });

    it('should throw StorageError when data directory does not exist', async () => {
      vol.reset(); // Clear all files

      await expect(
        managementService.getStatus()
      ).rejects.toThrow('StorageError');
    });

    it('should handle permission errors gracefully', async () => {
      // Mock fs.readFile to throw permission error
      vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(
        new Error('EACCES: permission denied')
      );

      await expect(
        managementService.getStatus()
      ).rejects.toThrow('StorageError');
    });
  });

  describe('performance', () => {
    it('should handle large number of rooms efficiently', async () => {
      // Create 100 rooms
      const rooms: Record<string, any> = {};
      const roomFiles: Record<string, string> = {};
      
      for (let i = 0; i < 100; i++) {
        const roomName = `room-${i}`;
        rooms[roomName] = {
          createdAt: '2024-01-01T00:00:00.000Z',
          userCount: Math.floor(Math.random() * 10),
          messageCount: Math.floor(Math.random() * 1000)
        };
        
        roomFiles[`data/rooms/${roomName}/messages.jsonl`] = 
          new Array(Math.floor(Math.random() * 10)).fill(0)
            .map((_, j) => `{"id":"msg-${j}","agentName":"agent","message":"test","timestamp":"2024-01-01T10:00:00.000Z"}`)
            .join('\n');
            
        roomFiles[`data/rooms/${roomName}/presence.json`] = JSON.stringify({
          users: {
            agent1: { status: 'online', lastSeen: '2024-01-01T10:00:00.000Z' }
          }
        });
      }

      vol.fromJSON({
        'data/rooms.json': JSON.stringify({ rooms }),
        ...roomFiles
      });

      const startTime = Date.now();
      const result = await managementService.getStatus();
      const duration = Date.now() - startTime;

      expect(result.totalRooms).toBe(100);
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should handle large message files efficiently', async () => {
      // Create a room with 10,000 messages
      const messages = new Array(10000).fill(0)
        .map((_, i) => `{"id":"msg-${i}","agentName":"agent","message":"test message ${i}","timestamp":"2024-01-01T10:00:00.000Z"}`)
        .join('\n');

      vol.fromJSON({
        'data/rooms.json': JSON.stringify({
          rooms: {
            'large-room': {
              createdAt: '2024-01-01T00:00:00.000Z',
              userCount: 1,
              messageCount: 10000
            }
          }
        }),
        'data/rooms/large-room/messages.jsonl': messages,
        'data/rooms/large-room/presence.json': JSON.stringify({
          users: {
            agent1: { status: 'online', lastSeen: '2024-01-01T10:00:00.000Z' }
          }
        })
      });

      const startTime = Date.now();
      const result = await managementService.getRoomStatistics('large-room');
      const duration = Date.now() - startTime;

      expect(result.totalMessages).toBe(10000);
      expect(duration).toBeLessThan(500); // Should complete within 500ms
    });
  });
});