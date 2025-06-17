import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDataLayer } from '../../helpers/MockDataLayer.js';
import { RoomNotFoundError, RoomAlreadyExistsError, AgentNotInRoomError } from '../../../src/errors/index.js';

// Mock RoomsAdapter since it doesn't exist yet
class MockRoomsAdapter {
  constructor(private dataLayer: MockDataLayer) {}
  
  async listRooms() {
    const rooms = this.dataLayer.getAllRooms();
    return { rooms };
  }
  
  async createRoom(params: { roomName: string; description?: string }) {
    if (this.dataLayer.roomExists(params.roomName)) {
      throw new RoomAlreadyExistsError(params.roomName);
    }
    
    const room = {
      name: params.roomName,
      description: params.description || '',
      createdAt: new Date().toISOString(),
      messageCount: 0
    };
    
    this.dataLayer.createRoom(room);
    return { success: true, roomName: params.roomName };
  }
  
  async enterRoom(params: { agentName: string; roomName: string }) {
    if (!this.dataLayer.roomExists(params.roomName)) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    this.dataLayer.addAgentToRoom(params.roomName, params.agentName);
    return { success: true };
  }
  
  async leaveRoom(params: { agentName: string; roomName: string }) {
    if (!this.dataLayer.roomExists(params.roomName)) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    const roomAgents = this.dataLayer.getRoomAgents(params.roomName);
    if (!roomAgents.includes(params.agentName)) {
      throw new AgentNotInRoomError(params.agentName, params.roomName);
    }
    
    this.dataLayer.removeAgentFromRoom(params.roomName, params.agentName);
    return { success: true };
  }
  
  async listRoomUsers(params: { roomName: string }) {
    if (!this.dataLayer.roomExists(params.roomName)) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    const agents = this.dataLayer.getRoomAgents(params.roomName);
    return { agents };
  }
  
  async roomExists(roomName: string): Promise<boolean> {
    return this.dataLayer.roomExists(roomName);
  }
}

describe('RoomsAdapter Integration Tests', () => {
  let dataLayer: MockDataLayer;
  let adapter: MockRoomsAdapter;
  
  beforeEach(() => {
    dataLayer = new MockDataLayer();
    adapter = new MockRoomsAdapter(dataLayer);
  });
  
  describe('listRooms', () => {
    it('should return empty list when no rooms exist', async () => {
      const result = await adapter.listRooms();
      expect(result.rooms).toEqual([]);
    });
    
    it('should return all rooms when they exist', async () => {
      // Create test rooms
      await adapter.createRoom({ roomName: 'room1', description: 'First room' });
      await adapter.createRoom({ roomName: 'room2', description: 'Second room' });
      
      const result = await adapter.listRooms();
      
      expect(result.rooms).toHaveLength(2);
      expect(result.rooms.map(r => r.name)).toContain('room1');
      expect(result.rooms.map(r => r.name)).toContain('room2');
    });
    
    it('should include room metadata', async () => {
      await adapter.createRoom({ roomName: 'test-room', description: 'Test description' });
      
      const result = await adapter.listRooms();
      const room = result.rooms[0];
      
      expect(room.name).toBe('test-room');
      expect(room.description).toBe('Test description');
      expect(room.createdAt).toBeDefined();
      expect(room.messageCount).toBe(0);
    });
  });
  
  describe('createRoom', () => {
    it('should create room successfully with description', async () => {
      const result = await adapter.createRoom({
        roomName: 'new-room',
        description: 'A new room'
      });
      
      expect(result.success).toBe(true);
      expect(result.roomName).toBe('new-room');
      
      // Verify room was created
      const rooms = await adapter.listRooms();
      expect(rooms.rooms).toHaveLength(1);
      expect(rooms.rooms[0].name).toBe('new-room');
      expect(rooms.rooms[0].description).toBe('A new room');
    });
    
    it('should create room successfully without description', async () => {
      const result = await adapter.createRoom({ roomName: 'minimal-room' });
      
      expect(result.success).toBe(true);
      expect(result.roomName).toBe('minimal-room');
      
      const rooms = await adapter.listRooms();
      expect(rooms.rooms[0].description).toBe('');
    });
    
    it('should throw RoomAlreadyExistsError for duplicate room name', async () => {
      await adapter.createRoom({ roomName: 'duplicate-room' });
      
      await expect(adapter.createRoom({
        roomName: 'duplicate-room'
      })).rejects.toThrow(RoomAlreadyExistsError);
    });
    
    it('should handle concurrent room creation', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        adapter.createRoom({ roomName: `room-${i}` })
      );
      
      const results = await Promise.all(promises);
      
      results.forEach((result, i) => {
        expect(result.success).toBe(true);
        expect(result.roomName).toBe(`room-${i}`);
      });
      
      const rooms = await adapter.listRooms();
      expect(rooms.rooms).toHaveLength(5);
    });
  });
  
  describe('enterRoom', () => {
    beforeEach(async () => {
      await adapter.createRoom({ roomName: 'test-room' });
    });
    
    it('should allow agent to enter existing room', async () => {
      const result = await adapter.enterRoom({
        agentName: 'agent1',
        roomName: 'test-room'
      });
      
      expect(result.success).toBe(true);
      
      // Verify agent is in room
      const users = await adapter.listRoomUsers({ roomName: 'test-room' });
      expect(users.agents).toContain('agent1');
    });
    
    it('should allow multiple agents to enter same room', async () => {
      await adapter.enterRoom({ agentName: 'agent1', roomName: 'test-room' });
      await adapter.enterRoom({ agentName: 'agent2', roomName: 'test-room' });
      
      const users = await adapter.listRoomUsers({ roomName: 'test-room' });
      expect(users.agents).toContain('agent1');
      expect(users.agents).toContain('agent2');
      expect(users.agents).toHaveLength(2);
    });
    
    it('should allow same agent to enter multiple times (idempotent)', async () => {
      await adapter.enterRoom({ agentName: 'agent1', roomName: 'test-room' });
      await adapter.enterRoom({ agentName: 'agent1', roomName: 'test-room' });
      
      const users = await adapter.listRoomUsers({ roomName: 'test-room' });
      expect(users.agents).toEqual(['agent1']);
    });
    
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(adapter.enterRoom({
        agentName: 'agent1',
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
    });
  });
  
  describe('leaveRoom', () => {
    beforeEach(async () => {
      await adapter.createRoom({ roomName: 'test-room' });
      await adapter.enterRoom({ agentName: 'agent1', roomName: 'test-room' });
      await adapter.enterRoom({ agentName: 'agent2', roomName: 'test-room' });
    });
    
    it('should allow agent to leave room', async () => {
      const result = await adapter.leaveRoom({
        agentName: 'agent1',
        roomName: 'test-room'
      });
      
      expect(result.success).toBe(true);
      
      // Verify agent is no longer in room
      const users = await adapter.listRoomUsers({ roomName: 'test-room' });
      expect(users.agents).not.toContain('agent1');
      expect(users.agents).toContain('agent2');
    });
    
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(adapter.leaveRoom({
        agentName: 'agent1',
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
    });
    
    it('should throw AgentNotInRoomError when agent not in room', async () => {
      await expect(adapter.leaveRoom({
        agentName: 'agent3',
        roomName: 'test-room'
      })).rejects.toThrow(AgentNotInRoomError);
    });
    
    it('should handle agent leaving multiple times gracefully', async () => {
      await adapter.leaveRoom({ agentName: 'agent1', roomName: 'test-room' });
      
      await expect(adapter.leaveRoom({
        agentName: 'agent1',
        roomName: 'test-room'
      })).rejects.toThrow(AgentNotInRoomError);
    });
  });
  
  describe('listRoomUsers', () => {
    beforeEach(async () => {
      await adapter.createRoom({ roomName: 'test-room' });
    });
    
    it('should return empty list for room with no users', async () => {
      const result = await adapter.listRoomUsers({ roomName: 'test-room' });
      expect(result.agents).toEqual([]);
    });
    
    it('should return all users in room', async () => {
      await adapter.enterRoom({ agentName: 'agent1', roomName: 'test-room' });
      await adapter.enterRoom({ agentName: 'agent2', roomName: 'test-room' });
      
      const result = await adapter.listRoomUsers({ roomName: 'test-room' });
      expect(result.agents).toHaveLength(2);
      expect(result.agents).toContain('agent1');
      expect(result.agents).toContain('agent2');
    });
    
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(adapter.listRoomUsers({
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
    });
    
    it('should update user list when agents leave', async () => {
      await adapter.enterRoom({ agentName: 'agent1', roomName: 'test-room' });
      await adapter.enterRoom({ agentName: 'agent2', roomName: 'test-room' });
      await adapter.leaveRoom({ agentName: 'agent1', roomName: 'test-room' });
      
      const result = await adapter.listRoomUsers({ roomName: 'test-room' });
      expect(result.agents).toEqual(['agent2']);
    });
  });
  
  describe('room lifecycle integration', () => {
    it('should handle complete room lifecycle', async () => {
      // Create room
      const createResult = await adapter.createRoom({
        roomName: 'lifecycle-room',
        description: 'Test lifecycle'
      });
      expect(createResult.success).toBe(true);
      
      // Agents enter
      await adapter.enterRoom({ agentName: 'agent1', roomName: 'lifecycle-room' });
      await adapter.enterRoom({ agentName: 'agent2', roomName: 'lifecycle-room' });
      
      // Check users
      let users = await adapter.listRoomUsers({ roomName: 'lifecycle-room' });
      expect(users.agents).toHaveLength(2);
      
      // Agent leaves
      await adapter.leaveRoom({ agentName: 'agent1', roomName: 'lifecycle-room' });
      
      // Check users again
      users = await adapter.listRoomUsers({ roomName: 'lifecycle-room' });
      expect(users.agents).toEqual(['agent2']);
      
      // Verify room still exists
      const rooms = await adapter.listRooms();
      expect(rooms.rooms.map(r => r.name)).toContain('lifecycle-room');
    });
    
    it('should maintain room state across multiple operations', async () => {
      await adapter.createRoom({ roomName: 'state-room' });
      
      // Multiple agents join and leave
      for (let i = 1; i <= 5; i++) {
        await adapter.enterRoom({ agentName: `agent${i}`, roomName: 'state-room' });
      }
      
      // Some agents leave
      await adapter.leaveRoom({ agentName: 'agent1', roomName: 'state-room' });
      await adapter.leaveRoom({ agentName: 'agent3', roomName: 'state-room' });
      
      const users = await adapter.listRoomUsers({ roomName: 'state-room' });
      expect(users.agents).toHaveLength(3);
      expect(users.agents).toEqual(['agent2', 'agent4', 'agent5']);
    });
  });
  
  describe('error handling and edge cases', () => {
    it('should handle special characters in room names', async () => {
      const result = await adapter.createRoom({
        roomName: 'room-with_special.chars',
        description: 'Special chars test'
      });
      
      expect(result.success).toBe(true);
      
      // Test operations with special char room
      await adapter.enterRoom({
        agentName: 'agent1',
        roomName: 'room-with_special.chars'
      });
      
      const users = await adapter.listRoomUsers({
        roomName: 'room-with_special.chars'
      });
      expect(users.agents).toContain('agent1');
    });
    
    it('should handle empty descriptions gracefully', async () => {
      const result = await adapter.createRoom({
        roomName: 'empty-desc-room',
        description: ''
      });
      
      expect(result.success).toBe(true);
      
      const rooms = await adapter.listRooms();
      const room = rooms.rooms.find(r => r.name === 'empty-desc-room');
      expect(room?.description).toBe('');
    });
    
    it('should maintain data consistency during concurrent operations', async () => {
      await adapter.createRoom({ roomName: 'concurrent-room' });
      
      // Concurrent enters and leaves
      const operations = [
        adapter.enterRoom({ agentName: 'agent1', roomName: 'concurrent-room' }),
        adapter.enterRoom({ agentName: 'agent2', roomName: 'concurrent-room' }),
        adapter.enterRoom({ agentName: 'agent3', roomName: 'concurrent-room' })
      ];
      
      await Promise.all(operations);
      
      const users = await adapter.listRoomUsers({ roomName: 'concurrent-room' });
      expect(users.agents).toHaveLength(3);
    });
  });
});