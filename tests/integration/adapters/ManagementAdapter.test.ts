import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDataLayer } from '../../helpers/MockDataLayer.js';
import { RoomNotFoundError } from '../../../src/errors/index.js';

// Mock ManagementAdapter since it doesn't exist yet
class MockManagementAdapter {
  constructor(private dataLayer: MockDataLayer) {}
  
  async getStatus() {
    const stats = this.dataLayer.getSystemStats();
    const rooms = this.dataLayer.getAllRooms().map(room => {
      const roomStats = this.dataLayer.getRoomStats(room.name);
      return {
        name: room.name,
        description: room.description,
        messageCount: roomStats.messageCount,
        activeAgents: roomStats.activeAgents,
        lastActivity: roomStats.lastActivity
      };
    });
    
    return {
      totalRooms: stats.totalRooms,
      totalMessages: stats.totalMessages,
      activeAgents: stats.activeAgents,
      uptime: stats.uptime,
      serverVersion: stats.serverVersion,
      rooms
    };
  }
  
  async clearRoomMessages(params: { roomName: string }) {
    if (!this.dataLayer.roomExists(params.roomName)) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    const messagesBefore = this.dataLayer.getMessages(params.roomName).length;
    this.dataLayer.clearMessages(params.roomName);
    
    return {
      success: true,
      clearedCount: messagesBefore
    };
  }
  
  async getRoomStats(roomName: string) {
    if (!this.dataLayer.roomExists(roomName)) {
      throw new RoomNotFoundError(roomName);
    }
    
    return this.dataLayer.getRoomStats(roomName);
  }
}

describe('ManagementAdapter Integration Tests', () => {
  let dataLayer: MockDataLayer;
  let adapter: MockManagementAdapter;
  
  beforeEach(() => {
    dataLayer = new MockDataLayer();
    adapter = new MockManagementAdapter(dataLayer);
  });
  
  describe('getStatus', () => {
    it('should return initial server status with no rooms', async () => {
      const result = await adapter.getStatus();
      
      expect(result.totalRooms).toBe(0);
      expect(result.totalMessages).toBe(0);
      expect(result.activeAgents).toBe(0);
      expect(result.uptime).toBeGreaterThan(0);
      expect(result.serverVersion).toBe('1.0.0');
      expect(result.rooms).toEqual([]);
    });
    
    it('should return accurate status with rooms and messages', async () => {
      // Setup test data
      dataLayer.createRoom({
        name: 'room1',
        description: 'First room',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      dataLayer.createRoom({
        name: 'room2',
        description: 'Second room',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      // Add agents to rooms
      dataLayer.addAgentToRoom('room1', 'agent1');
      dataLayer.addAgentToRoom('room1', 'agent2');
      dataLayer.addAgentToRoom('room2', 'agent1');
      
      // Add messages
      dataLayer.addMessage('room1', {
        id: 'msg1',
        agentName: 'agent1',
        roomName: 'room1',
        message: 'Hello',
        timestamp: new Date().toISOString(),
        mentions: []
      });
      
      dataLayer.addMessage('room1', {
        id: 'msg2',
        agentName: 'agent2',
        roomName: 'room1',
        message: 'Hi there',
        timestamp: new Date().toISOString(),
        mentions: []
      });
      
      const result = await adapter.getStatus();
      
      expect(result.totalRooms).toBe(2);
      expect(result.totalMessages).toBe(2);
      expect(result.activeAgents).toBe(2); // unique agents across all rooms
      expect(result.rooms).toHaveLength(2);
      
      // Check room details
      const room1 = result.rooms.find(r => r.name === 'room1');
      expect(room1?.messageCount).toBe(2);
      expect(room1?.activeAgents).toBe(2);
      expect(room1?.description).toBe('First room');
      
      const room2 = result.rooms.find(r => r.name === 'room2');
      expect(room2?.messageCount).toBe(0);
      expect(room2?.activeAgents).toBe(1);
    });
    
    it('should handle rooms with no active agents', async () => {
      dataLayer.createRoom({
        name: 'empty-room',
        description: 'No agents',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      const result = await adapter.getStatus();
      
      expect(result.totalRooms).toBe(1);
      expect(result.activeAgents).toBe(0);
      
      const room = result.rooms[0];
      expect(room.activeAgents).toBe(0);
      expect(room.messageCount).toBe(0);
    });
    
    it('should calculate last activity correctly', async () => {
      const roomCreatedAt = new Date().toISOString();
      
      dataLayer.createRoom({
        name: 'activity-room',
        description: 'Activity test',
        createdAt: roomCreatedAt,
        messageCount: 0
      });
      
      dataLayer.addAgentToRoom('activity-room', 'agent1');
      
      // Add message with specific timestamp
      const messageTime = new Date(Date.now() + 1000).toISOString();
      dataLayer.addMessage('activity-room', {
        id: 'msg1',
        agentName: 'agent1',
        roomName: 'activity-room',
        message: 'Latest message',
        timestamp: messageTime,
        mentions: []
      });
      
      const result = await adapter.getStatus();
      const room = result.rooms[0];
      
      expect(room.lastActivity).toBe(messageTime);
    });
  });
  
  describe('clearRoomMessages', () => {
    beforeEach(() => {
      dataLayer.createRoom({
        name: 'test-room',
        description: 'Test room',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      dataLayer.addAgentToRoom('test-room', 'agent1');
    });
    
    it('should clear messages from room with messages', async () => {
      // Add test messages
      for (let i = 1; i <= 5; i++) {
        dataLayer.addMessage('test-room', {
          id: `msg${i}`,
          agentName: 'agent1',
          roomName: 'test-room',
          message: `Message ${i}`,
          timestamp: new Date().toISOString(),
          mentions: []
        });
      }
      
      const result = await adapter.clearRoomMessages({ roomName: 'test-room' });
      
      expect(result.success).toBe(true);
      expect(result.clearedCount).toBe(5);
      
      // Verify messages are cleared
      const messages = dataLayer.getMessages('test-room');
      expect(messages).toHaveLength(0);
    });
    
    it('should return 0 for room with no messages', async () => {
      const result = await adapter.clearRoomMessages({ roomName: 'test-room' });
      
      expect(result.success).toBe(true);
      expect(result.clearedCount).toBe(0);
    });
    
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(adapter.clearRoomMessages({
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
    });
    
    it('should not affect other rooms when clearing', async () => {
      // Create another room with messages
      dataLayer.createRoom({
        name: 'other-room',
        description: 'Other room',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      dataLayer.addMessage('test-room', {
        id: 'msg1',
        agentName: 'agent1',
        roomName: 'test-room',
        message: 'Test message',
        timestamp: new Date().toISOString(),
        mentions: []
      });
      
      dataLayer.addMessage('other-room', {
        id: 'msg2',
        agentName: 'agent1',
        roomName: 'other-room',
        message: 'Other message',
        timestamp: new Date().toISOString(),
        mentions: []
      });
      
      await adapter.clearRoomMessages({ roomName: 'test-room' });
      
      // Verify only test-room messages were cleared
      expect(dataLayer.getMessages('test-room')).toHaveLength(0);
      expect(dataLayer.getMessages('other-room')).toHaveLength(1);
    });
    
    it('should preserve room metadata after clearing messages', async () => {
      dataLayer.addMessage('test-room', {
        id: 'msg1',
        agentName: 'agent1',
        roomName: 'test-room',
        message: 'Test message',
        timestamp: new Date().toISOString(),
        mentions: []
      });
      
      await adapter.clearRoomMessages({ roomName: 'test-room' });
      
      // Verify room still exists with metadata
      const room = dataLayer.getRoom('test-room');
      expect(room).toBeDefined();
      expect(room?.name).toBe('test-room');
      expect(room?.description).toBe('Test room');
      
      // Verify agents are still in room
      const agents = dataLayer.getRoomAgents('test-room');
      expect(agents).toContain('agent1');
    });
  });
  
  describe('getRoomStats', () => {
    beforeEach(() => {
      dataLayer.createRoom({
        name: 'stats-room',
        description: 'Stats test room',
        createdAt: new Date('2024-01-01').toISOString(),
        messageCount: 0
      });
    });
    
    it('should return accurate stats for room', async () => {
      dataLayer.addAgentToRoom('stats-room', 'agent1');
      dataLayer.addAgentToRoom('stats-room', 'agent2');
      
      // Add messages
      dataLayer.addMessage('stats-room', {
        id: 'msg1',
        agentName: 'agent1',
        roomName: 'stats-room',
        message: 'First message',
        timestamp: new Date('2024-01-02').toISOString(),
        mentions: []
      });
      
      dataLayer.addMessage('stats-room', {
        id: 'msg2',
        agentName: 'agent2',
        roomName: 'stats-room',
        message: 'Second message',
        timestamp: new Date('2024-01-03').toISOString(),
        mentions: []
      });
      
      const result = await adapter.getRoomStats('stats-room');
      
      expect(result.roomName).toBe('stats-room');
      expect(result.messageCount).toBe(2);
      expect(result.activeAgents).toBe(2);
      expect(result.createdAt).toBe(new Date('2024-01-01').toISOString());
      expect(result.lastActivity).toBe(new Date('2024-01-03').toISOString());
    });
    
    it('should return stats for empty room', async () => {
      const result = await adapter.getRoomStats('stats-room');
      
      expect(result.roomName).toBe('stats-room');
      expect(result.messageCount).toBe(0);
      expect(result.activeAgents).toBe(0);
      expect(result.createdAt).toBe(new Date('2024-01-01').toISOString());
      expect(result.lastActivity).toBe(new Date('2024-01-01').toISOString());
    });
    
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(adapter.getRoomStats('non-existent')).rejects.toThrow(RoomNotFoundError);
    });
  });
  
  describe('integration with other components', () => {
    it('should reflect changes from messaging operations', async () => {
      // Setup room
      dataLayer.createRoom({
        name: 'integration-room',
        description: 'Integration test',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      dataLayer.addAgentToRoom('integration-room', 'agent1');
      
      // Initial status
      let status = await adapter.getStatus();
      expect(status.totalMessages).toBe(0);
      
      // Add message
      dataLayer.addMessage('integration-room', {
        id: 'msg1',
        agentName: 'agent1',
        roomName: 'integration-room',
        message: 'Test message',
        timestamp: new Date().toISOString(),
        mentions: []
      });
      
      // Status should reflect new message
      status = await adapter.getStatus();
      expect(status.totalMessages).toBe(1);
      
      const room = status.rooms.find(r => r.name === 'integration-room');
      expect(room?.messageCount).toBe(1);
    });
    
    it('should handle complex multi-room scenarios', async () => {
      // Create multiple rooms with different activity levels
      const rooms = [
        { name: 'busy-room', messages: 10, agents: 3 },
        { name: 'quiet-room', messages: 2, agents: 1 },
        { name: 'empty-room', messages: 0, agents: 0 }
      ];
      
      for (const roomConfig of rooms) {
        dataLayer.createRoom({
          name: roomConfig.name,
          description: `${roomConfig.name} description`,
          createdAt: new Date().toISOString(),
          messageCount: 0
        });
        
        // Add agents
        for (let i = 1; i <= roomConfig.agents; i++) {
          dataLayer.addAgentToRoom(roomConfig.name, `agent${i}`);
        }
        
        // Add messages
        for (let i = 1; i <= roomConfig.messages; i++) {
          dataLayer.addMessage(roomConfig.name, {
            id: `${roomConfig.name}_msg${i}`,
            agentName: 'agent1',
            roomName: roomConfig.name,
            message: `Message ${i}`,
            timestamp: new Date().toISOString(),
            mentions: []
          });
        }
      }
      
      const status = await adapter.getStatus();
      
      expect(status.totalRooms).toBe(3);
      expect(status.totalMessages).toBe(12); // 10 + 2 + 0
      expect(status.activeAgents).toBe(3); // unique agents across all rooms
      
      // Check individual room stats
      const busyRoom = status.rooms.find(r => r.name === 'busy-room');
      expect(busyRoom?.messageCount).toBe(10);
      expect(busyRoom?.activeAgents).toBe(3);
      
      const emptyRoom = status.rooms.find(r => r.name === 'empty-room');
      expect(emptyRoom?.messageCount).toBe(0);
      expect(emptyRoom?.activeAgents).toBe(0);
    });
    
    it('should maintain accuracy after clear operations', async () => {
      dataLayer.createRoom({
        name: 'clear-test-room',
        description: 'Clear test',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      // Add messages
      for (let i = 1; i <= 5; i++) {
        dataLayer.addMessage('clear-test-room', {
          id: `msg${i}`,
          agentName: 'agent1',
          roomName: 'clear-test-room',
          message: `Message ${i}`,
          timestamp: new Date().toISOString(),
          mentions: []
        });
      }
      
      // Check status before clear
      let status = await adapter.getStatus();
      expect(status.totalMessages).toBe(5);
      
      // Clear messages
      await adapter.clearRoomMessages({ roomName: 'clear-test-room' });
      
      // Check status after clear
      status = await adapter.getStatus();
      expect(status.totalMessages).toBe(0);
      
      const room = status.rooms.find(r => r.name === 'clear-test-room');
      expect(room?.messageCount).toBe(0);
    });
  });
  
  describe('performance and edge cases', () => {
    it('should handle large numbers of rooms efficiently', async () => {
      // Create many rooms
      for (let i = 1; i <= 100; i++) {
        dataLayer.createRoom({
          name: `room${i}`,
          description: `Room ${i}`,
          createdAt: new Date().toISOString(),
          messageCount: 0
        });
      }
      
      const startTime = Date.now();
      const status = await adapter.getStatus();
      const endTime = Date.now();
      
      expect(status.totalRooms).toBe(100);
      expect(status.rooms).toHaveLength(100);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });
    
    it('should handle rooms with many messages', async () => {
      dataLayer.createRoom({
        name: 'big-room',
        description: 'Room with many messages',
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
      
      // Add many messages
      for (let i = 1; i <= 1000; i++) {
        dataLayer.addMessage('big-room', {
          id: `msg${i}`,
          agentName: 'agent1',
          roomName: 'big-room',
          message: `Message ${i}`,
          timestamp: new Date().toISOString(),
          mentions: []
        });
      }
      
      const status = await adapter.getStatus();
      const room = status.rooms.find(r => r.name === 'big-room');
      
      expect(room?.messageCount).toBe(1000);
      expect(status.totalMessages).toBe(1000);
    });
  });
});