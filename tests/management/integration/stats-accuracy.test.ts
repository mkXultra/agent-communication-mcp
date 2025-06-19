import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fs, vol } from 'memfs';

// Mock the fs module with memfs for testing
vi.mock('fs', () => fs);
vi.mock('fs/promises', () => fs.promises);

describe('Management Statistics Accuracy Integration Tests', () => {
  let managementService: any;
  let dataScanner: any;
  let statsCollector: any;

  beforeEach(async () => {
    // Reset the virtual file system
    vol.reset();
    
    // Create a comprehensive test scenario with multiple rooms
    vol.fromJSON({
      'data/rooms.json': JSON.stringify({
        rooms: {
          'marketing-team': { 
            createdAt: '2024-01-01T00:00:00.000Z',
            userCount: 6, 
            messageCount: 245 
          },
          'dev-squad': { 
            createdAt: '2024-01-02T00:00:00.000Z',
            userCount: 4, 
            messageCount: 189 
          },
          'general-chat': {
            createdAt: '2024-01-03T00:00:00.000Z',
            userCount: 8,
            messageCount: 432
          },
          'project-alpha': {
            createdAt: '2024-01-04T00:00:00.000Z',
            userCount: 3,
            messageCount: 76
          },
          'empty-project': {
            createdAt: '2024-01-05T00:00:00.000Z',
            userCount: 0,
            messageCount: 0
          },
          'archived-room': {
            createdAt: '2024-01-06T00:00:00.000Z',
            userCount: 2,
            messageCount: 15
          }
        }
      }),
      
      // Marketing team - High activity
      'data/rooms/marketing-team/messages.jsonl': 
        new Array(245).fill(0)
          .map((_, i) => {
            const agents = ['sarah', 'mike', 'jessica', 'david', 'emma', 'alex'];
            const agentName = agents[i % agents.length];
            const hour = 9 + Math.floor(i / 30); // Spread across work hours
            const minute = (i * 2) % 60;
            return `{"id":"msg-${i+1}","agentName":"${agentName}","message":"Marketing discussion ${i+1}","timestamp":"2024-01-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z"}`;
          })
          .join('\n'),
      'data/rooms/marketing-team/presence.json': JSON.stringify({
        users: {
          sarah: { status: 'online', lastSeen: '2024-01-01T17:30:00.000Z' },
          mike: { status: 'online', lastSeen: '2024-01-01T17:25:00.000Z' },
          jessica: { status: 'offline', lastSeen: '2024-01-01T16:45:00.000Z' },
          david: { status: 'online', lastSeen: '2024-01-01T17:28:00.000Z' },
          emma: { status: 'away', lastSeen: '2024-01-01T17:00:00.000Z' },
          alex: { status: 'offline', lastSeen: '2024-01-01T15:30:00.000Z' }
        }
      }),

      // Dev squad - Medium activity
      'data/rooms/dev-squad/messages.jsonl': 
        new Array(189).fill(0)
          .map((_, i) => {
            const agents = ['alice', 'bob', 'charlie', 'diana'];
            const agentName = agents[i % agents.length];
            return `{"id":"dev-msg-${i+1}","agentName":"${agentName}","message":"Code review comment ${i+1}","timestamp":"2024-01-02T${String(10 + Math.floor(i / 20)).padStart(2, '0')}:${String((i * 3) % 60).padStart(2, '0')}:00.000Z"}`;
          })
          .join('\n'),
      'data/rooms/dev-squad/presence.json': JSON.stringify({
        users: {
          alice: { status: 'online', lastSeen: '2024-01-02T18:00:00.000Z' },
          bob: { status: 'online', lastSeen: '2024-01-02T17:55:00.000Z' },
          charlie: { status: 'offline', lastSeen: '2024-01-02T17:00:00.000Z' },
          diana: { status: 'online', lastSeen: '2024-01-02T18:05:00.000Z' }
        }
      }),

      // General chat - High activity, many users
      'data/rooms/general-chat/messages.jsonl': 
        new Array(432).fill(0)
          .map((_, i) => {
            const agents = ['user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7', 'user8'];
            const agentName = agents[i % agents.length];
            return `{"id":"general-${i+1}","agentName":"${agentName}","message":"General chat message ${i+1}","timestamp":"2024-01-03T${String(8 + Math.floor(i / 50)).padStart(2, '0')}:${String((i * 1.5) % 60).padStart(2, '0')}:00.000Z"}`;
          })
          .join('\n'),
      'data/rooms/general-chat/presence.json': JSON.stringify({
        users: {
          user1: { status: 'online', lastSeen: '2024-01-03T19:00:00.000Z' },
          user2: { status: 'online', lastSeen: '2024-01-03T18:58:00.000Z' },
          user3: { status: 'online', lastSeen: '2024-01-03T19:02:00.000Z' },
          user4: { status: 'offline', lastSeen: '2024-01-03T17:30:00.000Z' },
          user5: { status: 'online', lastSeen: '2024-01-03T18:55:00.000Z' },
          user6: { status: 'offline', lastSeen: '2024-01-03T16:00:00.000Z' },
          user7: { status: 'online', lastSeen: '2024-01-03T19:01:00.000Z' },
          user8: { status: 'offline', lastSeen: '2024-01-03T18:00:00.000Z' }
        }
      }),

      // Project alpha - Small focused team
      'data/rooms/project-alpha/messages.jsonl': 
        new Array(76).fill(0)
          .map((_, i) => {
            const agents = ['lead', 'dev1', 'designer'];
            const agentName = agents[i % agents.length];
            return `{"id":"alpha-${i+1}","agentName":"${agentName}","message":"Project alpha update ${i+1}","timestamp":"2024-01-04T${String(9 + Math.floor(i / 10)).padStart(2, '0')}:${String((i * 5) % 60).padStart(2, '0')}:00.000Z"}`;
          })
          .join('\n'),
      'data/rooms/project-alpha/presence.json': JSON.stringify({
        users: {
          lead: { status: 'online', lastSeen: '2024-01-04T16:30:00.000Z' },
          dev1: { status: 'offline', lastSeen: '2024-01-04T15:45:00.000Z' },
          designer: { status: 'online', lastSeen: '2024-01-04T16:25:00.000Z' }
        }
      }),

      // Empty project - No activity
      'data/rooms/empty-project/messages.jsonl': '',
      'data/rooms/empty-project/presence.json': JSON.stringify({
        users: {}
      }),

      // Archived room - Minimal activity, users offline
      'data/rooms/archived-room/messages.jsonl': 
        new Array(15).fill(0)
          .map((_, i) => `{"id":"arch-${i+1}","agentName":"olduser${(i % 2) + 1}","message":"Old message ${i+1}","timestamp":"2024-01-06T10:${String(i * 2).padStart(2, '0')}:00.000Z"}`)
          .join('\n'),
      'data/rooms/archived-room/presence.json': JSON.stringify({
        users: {
          olduser1: { status: 'offline', lastSeen: '2024-01-06T10:28:00.000Z' },
          olduser2: { status: 'offline', lastSeen: '2024-01-06T10:30:00.000Z' }
        }
      })
    });

    // Import the services using ES modules
    const { ManagementService } = await import('../../../src/features/management');
    const { DataScanner } = await import('../../../src/features/management/DataScanner');
    const { StatsCollector } = await import('../../../src/features/management/StatsCollector');
    
    managementService = new ManagementService();
    dataScanner = new DataScanner();
    statsCollector = new StatsCollector();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Cross-service Statistics Consistency', () => {
    it('should have consistent statistics across all services', async () => {
      // Get stats from all three services
      const [systemStats, scanResults, collectorStats] = await Promise.all([
        managementService.getSystemStatus(),
        dataScanner.scanAllRooms(),
        statsCollector.collectSystemStats()
      ]);

      // All services should report the same totals
      expect(systemStats.totalRooms).toBe(6);
      expect(scanResults.totalRooms).toBe(6);
      expect(collectorStats.totalRooms).toBe(6);

      expect(systemStats.totalMessages).toBe(957); // 245 + 189 + 432 + 76 + 0 + 15
      expect(scanResults.totalMessages).toBe(957);
      expect(collectorStats.totalMessages).toBe(957);

      expect(systemStats.totalOnlineUsers).toBe(12); // 3 + 3 + 5 + 2 + 0 + 0 (only counting 'online' status)
      expect(scanResults.totalOnlineUsers).toBe(12);
      expect(collectorStats.totalOnlineUsers).toBe(12);

      // Storage sizes should be consistent
      expect(systemStats.totalStorageSize).toBeGreaterThan(0);
      expect(systemStats.totalStorageSize).toBe(scanResults.totalStorageSize);
      expect(systemStats.totalStorageSize).toBe(collectorStats.totalStorageSize);
    });

    it('should have consistent room-level statistics', async () => {
      const roomName = 'marketing-team';
      
      // Get room stats from different services
      const [roomStats, scanResult, collectorRoom] = await Promise.all([
        managementService.getRoomStatistics(roomName),
        dataScanner.scanRoomDirectory(roomName),
        statsCollector.collectRoomStats(roomName)
      ]);

      // All services should report the same room data
      expect(roomStats.totalMessages).toBe(245);
      expect(scanResult.messageCount).toBe(245);
      expect(collectorRoom.totalMessages).toBe(245);

      expect(roomStats.onlineUsers).toBe(3); // sarah, mike, david are online
      expect(scanResult.onlineUsers).toBe(3);
      expect(collectorRoom.onlineUsers).toBe(3);

      // Storage sizes should match
      expect(roomStats.storageSize).toBe(scanResult.storageSize);
      expect(roomStats.storageSize).toBe(collectorRoom.storageSize);
    });
  });

  describe('Message Count Accuracy', () => {
    it('should count messages accurately across different room sizes', async () => {
      const expectedCounts = {
        'marketing-team': 245,
        'dev-squad': 189,
        'general-chat': 432,
        'project-alpha': 76,
        'empty-project': 0,
        'archived-room': 15
      };

      for (const [roomName, expectedCount] of Object.entries(expectedCounts)) {
        const roomStats = await managementService.getRoomStatistics(roomName);
        const scanResult = await dataScanner.scanRoomDirectory(roomName);
        
        expect(roomStats.totalMessages).toBe(expectedCount);
        expect(scanResult.messageCount).toBe(expectedCount);
        
        // Verify by actually counting lines in the file
        const actualLines = await dataScanner.countLines(`data/rooms/${roomName}/messages.jsonl`);
        expect(actualLines).toBe(expectedCount);
      }
    });

    it('should accurately count messages by agent', async () => {
      const roomStats = await statsCollector.collectRoomStats('marketing-team');
      
      // Each of 6 agents should have roughly equal messages (245 / 6 ≈ 40-41 each)
      const messagesByAgent = roomStats.messagesByAgent;
      const totalMessages = Object.values(messagesByAgent).reduce((sum: number, count: any) => sum + count, 0);
      
      expect(totalMessages).toBe(245);
      expect(Object.keys(messagesByAgent)).toHaveLength(6);
      
      // Each agent should have between 40-42 messages (245 / 6 = 40.83)
      for (const [agent, count] of Object.entries(messagesByAgent)) {
        expect(count).toBeGreaterThanOrEqual(40);
        expect(count).toBeLessThanOrEqual(42);
      }
    });
  });

  describe('Online User Count Accuracy', () => {
    it('should count online users accurately across all rooms', async () => {
      const expectedOnlineCounts = {
        'marketing-team': 3, // sarah, mike, david
        'dev-squad': 3, // alice, bob, diana
        'general-chat': 5, // user1, user2, user3, user5, user7
        'project-alpha': 2, // lead, designer
        'empty-project': 0,
        'archived-room': 0 // all offline
      };

      for (const [roomName, expectedCount] of Object.entries(expectedOnlineCounts)) {
        const roomStats = await managementService.getRoomStatistics(roomName);
        const scanResult = await dataScanner.scanRoomDirectory(roomName);
        
        expect(roomStats.onlineUsers).toBe(expectedCount);
        expect(scanResult.onlineUsers).toBe(expectedCount);
        
        // Verify by checking presence file directly
        const actualOnlineCount = await dataScanner.countOnlineUsers(`data/rooms/${roomName}/presence.json`);
        expect(actualOnlineCount).toBe(expectedCount);
      }
    });

    it('should handle different user status types correctly', async () => {
      // Marketing team has mixed status types (online, offline, away)
      const roomStats = await managementService.getRoomStatistics('marketing-team');
      
      // Only 'online' status should be counted (not 'away' or 'offline')
      expect(roomStats.onlineUsers).toBe(3);
      expect(roomStats.users.sarah.status).toBe('online');
      expect(roomStats.users.mike.status).toBe('online');
      expect(roomStats.users.david.status).toBe('online');
      expect(roomStats.users.emma.status).toBe('away'); // Not counted as online
      expect(roomStats.users.jessica.status).toBe('offline');
      expect(roomStats.users.alex.status).toBe('offline');
    });
  });

  describe('Storage Size Accuracy', () => {
    it('should calculate storage sizes accurately', async () => {
      const systemStats = await managementService.getSystemStatus();
      
      // Calculate expected total storage size
      let expectedTotalSize = 0;
      for (const room of systemStats.rooms) {
        const messagesPath = `data/rooms/${room.name}/messages.jsonl`;
        const content = fs.readFileSync(messagesPath, 'utf8');
        const expectedSize = Buffer.from(content).length;
        
        expect(room.storageSize).toBe(expectedSize);
        expectedTotalSize += expectedSize;
      }
      
      expect(systemStats.totalStorageSize).toBe(expectedTotalSize);
    });

    it('should handle empty files correctly', async () => {
      const roomStats = await managementService.getRoomStatistics('empty-project');
      expect(roomStats.storageSize).toBe(0);
    });
  });

  describe('Data Integrity After Operations', () => {
    it('should maintain accuracy after clearing room messages', async () => {
      // Get initial system stats
      const initialStats = await managementService.getSystemStatus();
      const initialTotalMessages = initialStats.totalMessages;
      const roomToSlear = 'project-alpha';
      const roomMessagesBefore = initialStats.rooms.find(r => r.name === roomToSlear)?.totalMessages || 0;
      
      // Clear messages from one room
      const clearResult = await managementService.clearRoomMessages(roomToSlear, true);
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedCount).toBe(76);
      
      // Get updated stats
      const updatedStats = await managementService.getSystemStatus();
      
      // Total messages should decrease by the cleared amount
      expect(updatedStats.totalMessages).toBe(initialTotalMessages - roomMessagesBefore);
      
      // Cleared room should have 0 messages
      const clearedRoom = updatedStats.rooms.find(r => r.name === roomToSlear);
      expect(clearedRoom?.totalMessages).toBe(0);
      expect(clearedRoom?.storageSize).toBe(0);
      
      // Other rooms should be unaffected
      const otherRooms = updatedStats.rooms.filter(r => r.name !== roomToSlear);
      for (const room of otherRooms) {
        const originalRoom = initialStats.rooms.find(r => r.name === room.name);
        expect(room.totalMessages).toBe(originalRoom?.totalMessages);
        expect(room.storageSize).toBe(originalRoom?.storageSize);
      }
    });

    it('should maintain consistency across services after data changes', async () => {
      // Add new messages to a room by directly modifying the file
      const newMessages = [
        '{"id":"new-1","agentName":"newuser","message":"New message 1","timestamp":"2024-01-07T10:00:00.000Z"}',
        '{"id":"new-2","agentName":"newuser","message":"New message 2","timestamp":"2024-01-07T10:01:00.000Z"}'
      ];
      
      const currentContent = fs.readFileSync('data/rooms/project-alpha/messages.jsonl', 'utf8');
      const newContent = currentContent + '\n' + newMessages.join('\n');
      fs.writeFileSync('data/rooms/project-alpha/messages.jsonl', newContent);
      
      // Update rooms.json to reflect the change
      const roomsData = JSON.parse(fs.readFileSync('data/rooms.json', 'utf8'));
      roomsData.rooms['project-alpha'].messageCount = 78; // 76 + 2
      fs.writeFileSync('data/rooms.json', JSON.stringify(roomsData));
      
      // All services should report the new count
      const [systemStats, scanResult, collectorStats] = await Promise.all([
        managementService.getSystemStatus(),
        dataScanner.scanRoomDirectory('project-alpha'),
        statsCollector.collectRoomStats('project-alpha')
      ]);
      
      expect(systemStats.totalMessages).toBe(959); // 957 + 2
      expect(scanResult.messageCount).toBe(78);
      expect(collectorStats.totalMessages).toBe(78);
    });
  });

  describe('Performance Under Load', () => {
    it('should maintain accuracy even with concurrent access', async () => {
      // Simulate concurrent requests to different services
      const concurrentPromises = [
        managementService.getSystemStatus(),
        dataScanner.scanAllRooms(),
        statsCollector.collectSystemStats(),
        managementService.getRoomStatistics('general-chat'),
        managementService.getRoomStatistics('marketing-team'),
        dataScanner.scanRoomDirectory('dev-squad'),
        statsCollector.collectRoomStats('project-alpha'),
        statsCollector.collectMostActiveRoom()
      ];
      
      const results = await Promise.all(concurrentPromises);
      
      // All system-level stats should be consistent
      const [systemStats1, scanResults, collectorStats] = results.slice(0, 3);
      
      expect(systemStats1.totalRooms).toBe(scanResults.totalRooms);
      expect(scanResults.totalRooms).toBe(collectorStats.totalRooms);
      expect(systemStats1.totalMessages).toBe(scanResults.totalMessages);
      expect(scanResults.totalMessages).toBe(collectorStats.totalMessages);
      expect(systemStats1.totalOnlineUsers).toBe(scanResults.totalOnlineUsers);
      expect(scanResults.totalOnlineUsers).toBe(collectorStats.totalOnlineUsers);
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    it('should handle partially corrupted data gracefully while maintaining accuracy for valid data', async () => {
      // Corrupt one room's presence file
      fs.writeFileSync('data/rooms/dev-squad/presence.json', 'invalid json');
      
      // System should still process other rooms correctly
      const systemStats = await managementService.getSystemStatus();
      
      expect(systemStats.totalRooms).toBe(6); // All rooms should still be counted
      
      // The corrupted room should have 0 online users but correct message count
      const devSquadRoom = systemStats.rooms.find(r => r.name === 'dev-squad');
      expect(devSquadRoom?.onlineUsers).toBe(0); // Presence file corrupted
      expect(devSquadRoom?.totalMessages).toBe(189); // Messages should still be counted correctly
      
      // Other rooms should be unaffected
      const marketingRoom = systemStats.rooms.find(r => r.name === 'marketing-team');
      expect(marketingRoom?.onlineUsers).toBe(3);
      expect(marketingRoom?.totalMessages).toBe(245);
    });

    it('should maintain accuracy when rooms have malformed message lines', async () => {
      // Add some malformed lines to a room's messages
      const validMessages = fs.readFileSync('data/rooms/project-alpha/messages.jsonl', 'utf8');
      const messagesWithErrors = validMessages + '\n' +
        'invalid json line\n' +
        '{"incomplete": "json"}\n' +
        '{"id":"valid","agentName":"user","message":"This is valid","timestamp":"2024-01-04T16:00:00.000Z"}';
      
      fs.writeFileSync('data/rooms/project-alpha/messages.jsonl', messagesWithErrors);
      
      const roomStats = await statsCollector.collectRoomStats('project-alpha');
      
      // Should count only valid JSON lines (76 original + 1 new valid = 77)
      expect(roomStats.totalMessages).toBe(77);
      
      // Should handle the valid message correctly
      expect(roomStats.messagesByAgent.user).toBe(1);
    });
  });
});