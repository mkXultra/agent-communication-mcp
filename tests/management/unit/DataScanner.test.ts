import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fs, vol } from 'memfs';
import { Readable } from 'stream';

// Mock the fs module with memfs for testing
vi.mock('fs', () => fs);
vi.mock('fs/promises', () => fs.promises);

describe('DataScanner', () => {
  let dataScanner: any;

  beforeEach(() => {
    // Reset the virtual file system
    vol.reset();
    
    // Create comprehensive test directory structure
    vol.fromJSON({
      'data/rooms.json': JSON.stringify({
        rooms: {
          'test-room-1': { 
            createdAt: '2024-01-01T00:00:00.000Z',
            userCount: 3, 
            messageCount: 5 
          },
          'test-room-2': { 
            createdAt: '2024-01-02T00:00:00.000Z',
            userCount: 2, 
            messageCount: 10 
          },
          'empty-room': {
            createdAt: '2024-01-03T00:00:00.000Z',
            userCount: 0,
            messageCount: 0
          },
          'partial-files-room': {
            createdAt: '2024-01-04T00:00:00.000Z',
            userCount: 1,
            messageCount: 3
          }
        }
      }),
      // Room 1: Small room with few messages
      'data/rooms/test-room-1/messages.jsonl': 
        '{"id":"msg1","agentName":"alice","message":"Hello world","timestamp":"2024-01-01T10:00:00.000Z"}\n' +
        '{"id":"msg2","agentName":"bob","message":"Hi there","timestamp":"2024-01-01T10:01:00.000Z"}\n' +
        '{"id":"msg3","agentName":"alice","message":"How are you?","timestamp":"2024-01-01T10:02:00.000Z"}\n' +
        '{"id":"msg4","agentName":"charlie","message":"I am fine","timestamp":"2024-01-01T10:03:00.000Z"}\n' +
        '{"id":"msg5","agentName":"bob","message":"Great!","timestamp":"2024-01-01T10:04:00.000Z"}',
      'data/rooms/test-room-1/presence.json': JSON.stringify({
        users: {
          alice: { status: 'online', lastSeen: '2024-01-01T10:02:00.000Z' },
          bob: { status: 'offline', lastSeen: '2024-01-01T09:30:00.000Z' },
          charlie: { status: 'online', lastSeen: '2024-01-01T10:03:00.000Z' }
        }
      }),
      // Room 2: Medium room with more messages
      'data/rooms/test-room-2/messages.jsonl': 
        new Array(10).fill(0)
          .map((_, i) => `{"id":"msg-${i+1}","agentName":"user${(i % 2) + 1}","message":"Message number ${i+1}","timestamp":"2024-01-02T10:${String(i).padStart(2, '0')}:00.000Z"}`)
          .join('\n'),
      'data/rooms/test-room-2/presence.json': JSON.stringify({
        users: {
          user1: { status: 'online', lastSeen: '2024-01-02T10:05:00.000Z' },
          user2: { status: 'online', lastSeen: '2024-01-02T10:06:00.000Z' }
        }
      }),
      // Empty room
      'data/rooms/empty-room/messages.jsonl': '',
      'data/rooms/empty-room/presence.json': JSON.stringify({
        users: {}
      }),
      // Room with only messages file (missing presence)
      'data/rooms/partial-files-room/messages.jsonl':
        '{"id":"msg1","agentName":"solo","message":"Alone here","timestamp":"2024-01-04T10:00:00.000Z"}\n' +
        '{"id":"msg2","agentName":"solo","message":"Still alone","timestamp":"2024-01-04T10:01:00.000Z"}\n' +
        '{"id":"msg3","agentName":"solo","message":"Anyone there?","timestamp":"2024-01-04T10:02:00.000Z"}'
      // Note: presence.json is intentionally missing for partial-files-room
    });

    // Import DataScanner using ES modules
    const { DataScanner } = await import('../../../src/features/management/DataScanner');
    dataScanner = new DataScanner();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('scanRoomDirectory', () => {
    it('should scan room directory and return accurate statistics', async () => {
      const result = await dataScanner.scanRoomDirectory('test-room-1');
      
      expect(result).toMatchObject({
        messageCount: 5,
        onlineUsers: 2, // alice and charlie are online
        storageSize: expect.any(Number)
      });
      
      // Verify storage size is calculated correctly
      const expectedSize = Buffer.from(
        '{"id":"msg1","agentName":"alice","message":"Hello world","timestamp":"2024-01-01T10:00:00.000Z"}\n' +
        '{"id":"msg2","agentName":"bob","message":"Hi there","timestamp":"2024-01-01T10:01:00.000Z"}\n' +
        '{"id":"msg3","agentName":"alice","message":"How are you?","timestamp":"2024-01-01T10:02:00.000Z"}\n' +
        '{"id":"msg4","agentName":"charlie","message":"I am fine","timestamp":"2024-01-01T10:03:00.000Z"}\n' +
        '{"id":"msg5","agentName":"bob","message":"Great!","timestamp":"2024-01-01T10:04:00.000Z"}'
      ).length;
      
      expect(result.storageSize).toBe(expectedSize);
    });

    it('should handle empty room correctly', async () => {
      const result = await dataScanner.scanRoomDirectory('empty-room');
      
      expect(result).toMatchObject({
        messageCount: 0,
        onlineUsers: 0,
        storageSize: 0
      });
    });

    it('should handle missing presence file gracefully', async () => {
      const result = await dataScanner.scanRoomDirectory('partial-files-room');
      
      expect(result).toMatchObject({
        messageCount: 3,
        onlineUsers: 0, // No presence file means no online users
        storageSize: expect.any(Number)
      });
    });

    it('should handle missing messages file gracefully', async () => {
      // Remove messages file but keep presence
      vol.fromJSON({
        'data/rooms/test-room-1/presence.json': JSON.stringify({
          users: {
            alice: { status: 'online', lastSeen: '2024-01-01T10:02:00.000Z' }
          }
        })
      }, 'data/rooms/test-room-1');

      const result = await dataScanner.scanRoomDirectory('test-room-1');
      
      expect(result).toMatchObject({
        messageCount: 0,
        onlineUsers: 1,
        storageSize: 0
      });
    });

    it('should handle non-existent room directory gracefully', async () => {
      const result = await dataScanner.scanRoomDirectory('non-existent-room');
      
      expect(result).toMatchObject({
        messageCount: 0,
        onlineUsers: 0,
        storageSize: 0
      });
    });
  });


  describe('getFileStats', () => {
    it('should return file size for existing files', async () => {
      const stats = await dataScanner.getFileStats('data/rooms/test-room-1/messages.jsonl');
      
      expect(stats).toMatchObject({
        size: expect.any(Number),
        exists: true
      });
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should return zero size for non-existent files', async () => {
      const stats = await dataScanner.getFileStats('data/rooms/non-existent/messages.jsonl');
      
      expect(stats).toMatchObject({
        size: 0,
        exists: false
      });
    });

    it('should return zero size for empty files', async () => {
      const stats = await dataScanner.getFileStats('data/rooms/empty-room/messages.jsonl');
      
      expect(stats).toMatchObject({
        size: 0,
        exists: true
      });
    });
  });

  describe('countLines', () => {
    it('should count lines in message files accurately', async () => {
      const count = await dataScanner.countLines('data/rooms/test-room-1/messages.jsonl');
      expect(count).toBe(5);
    });

    it('should handle empty files', async () => {
      const count = await dataScanner.countLines('data/rooms/empty-room/messages.jsonl');
      expect(count).toBe(0);
    });

    it('should return 0 for non-existent files', async () => {
      const count = await dataScanner.countLines('data/rooms/non-existent/messages.jsonl');
      expect(count).toBe(0);
    });

    it('should use streaming for large files', async () => {
      // Create a large file to test streaming
      const largeContent = new Array(10000).fill(0)
        .map((_, i) => `{"id":"msg-${i}","agentName":"agent","message":"Message ${i}","timestamp":"2024-01-01T10:00:00.000Z"}`)
        .join('\n');
      
      vol.fromJSON({
        'data/rooms/test-room-1/messages.jsonl': largeContent
      });

      const count = await dataScanner.countLines('data/rooms/test-room-1/messages.jsonl');
      expect(count).toBe(10000);
    });

    it('should handle files with no trailing newline', async () => {
      vol.fromJSON({
        'data/rooms/test-room-1/messages.jsonl': 
          '{"id":"msg1","agentName":"alice","message":"Hello","timestamp":"2024-01-01T10:00:00.000Z"}\n' +
          '{"id":"msg2","agentName":"bob","message":"Hi","timestamp":"2024-01-01T10:01:00.000Z"}' // No trailing newline
      });

      const count = await dataScanner.countLines('data/rooms/test-room-1/messages.jsonl');
      expect(count).toBe(2);
    });
  });

  describe('countOnlineUsers', () => {
    it('should count online users correctly', async () => {
      const count = await dataScanner.countOnlineUsers('data/rooms/test-room-1/presence.json');
      expect(count).toBe(2); // alice and charlie are online
    });

    it('should handle empty presence files', async () => {
      const count = await dataScanner.countOnlineUsers('data/rooms/empty-room/presence.json');
      expect(count).toBe(0);
    });

    it('should return 0 for non-existent presence files', async () => {
      const count = await dataScanner.countOnlineUsers('data/rooms/non-existent/presence.json');
      expect(count).toBe(0);
    });

    it('should handle corrupted presence files', async () => {
      vol.fromJSON({
        'data/rooms/test-room-1/presence.json': 'invalid json content'
      });

      const count = await dataScanner.countOnlineUsers('data/rooms/test-room-1/presence.json');
      expect(count).toBe(0); // Should default to 0 on parse error
    });

    it('should handle presence file with mixed status types', async () => {
      vol.fromJSON({
        'data/rooms/test-room-1/presence.json': JSON.stringify({
          users: {
            user1: { status: 'online', lastSeen: '2024-01-01T10:00:00.000Z' },
            user2: { status: 'offline', lastSeen: '2024-01-01T09:00:00.000Z' },
            user3: { status: 'away', lastSeen: '2024-01-01T10:00:00.000Z' }, // Different status
            user4: { status: 'online', lastSeen: '2024-01-01T10:00:00.000Z' },
            user5: { status: null, lastSeen: '2024-01-01T10:00:00.000Z' } // Null status
          }
        })
      });

      const count = await dataScanner.countOnlineUsers('data/rooms/test-room-1/presence.json');
      expect(count).toBe(2); // Only user1 and user4 have status 'online'
    });
  });

  describe('performance and memory efficiency', () => {
    it('should handle very large message files efficiently', async () => {
      // Create a file with 100,000 lines
      const hugeContent = new Array(100000).fill(0)
        .map((_, i) => `{"id":"msg-${i}","agentName":"agent${i % 100}","message":"This is message number ${i} with some content to make it realistic size","timestamp":"2024-01-01T${String(10 + Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor((i % 3600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z"}`)
        .join('\n');

      vol.fromJSON({
        'data/rooms/huge-room/messages.jsonl': hugeContent,
        'data/rooms/huge-room/presence.json': JSON.stringify({
          users: {
            agent1: { status: 'online', lastSeen: '2024-01-01T15:00:00.000Z' }
          }
        })
      });

      const startTime = Date.now();
      const result = await dataScanner.scanRoomDirectory('huge-room');
      const duration = Date.now() - startTime;

      expect(result.messageCount).toBe(100000);
      expect(result.onlineUsers).toBe(1);
      expect(duration).toBeLessThan(3000); // Should complete within 3 seconds
    });

    it('should process multiple rooms concurrently', async () => {
      // Create many rooms to test concurrent processing
      const rooms: Record<string, any> = {};
      const roomFiles: Record<string, string> = {};
      
      for (let i = 0; i < 20; i++) {
        const roomName = `concurrent-room-${i}`;
        rooms[roomName] = {
          createdAt: '2024-01-01T00:00:00.000Z',
          userCount: Math.floor(Math.random() * 5),
          messageCount: Math.floor(Math.random() * 100)
        };
        
        roomFiles[`data/rooms/${roomName}/messages.jsonl`] = 
          new Array(Math.floor(Math.random() * 50)).fill(0)
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
      const result = await dataScanner.scanAllRooms();
      const duration = Date.now() - startTime;

      expect(result.totalRooms).toBe(20);
      expect(duration).toBeLessThan(2000); // Should complete within 2 seconds with concurrent processing
    });
  });

  describe('error handling', () => {
    it('should handle permission errors gracefully', async () => {
      // Mock fs.stat to throw permission error
      vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(
        new Error('EACCES: permission denied')
      );

      await expect(
        dataScanner.scanRoomDirectory('test-room-1')
      ).rejects.toThrow('StorageError');
    });

    it('should handle corrupted rooms.json file', async () => {
      vol.fromJSON({
        'data/rooms.json': 'invalid json content'
      });

      await expect(
        dataScanner.scanAllRooms()
      ).rejects.toThrow('StorageError');
    });

    it('should handle missing data directory', async () => {
      vol.reset(); // Clear all files

      await expect(
        dataScanner.scanAllRooms()
      ).rejects.toThrow('StorageError');
    });

    it('should continue scanning other rooms if one fails', async () => {
      // Mock scanRoomDirectory to fail for one specific room
      const originalScanRoomDirectory = dataScanner.scanRoomDirectory;
      vi.spyOn(dataScanner, 'scanRoomDirectory').mockImplementation(async (roomName: string) => {
        if (roomName === 'test-room-2') {
          throw new Error('Simulated scan error');
        }
        return originalScanRoomDirectory.call(dataScanner, roomName);
      });

      const result = await dataScanner.scanAllRooms();
      
      // Should still process other rooms
      expect(result.rooms.length).toBeGreaterThan(0);
      expect(result.rooms.some((r: any) => r.name === 'test-room-1')).toBe(true);
      expect(result.rooms.some((r: any) => r.name === 'test-room-2')).toBe(false);
    });
  });
});