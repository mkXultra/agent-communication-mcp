import { describe, it, expect, beforeEach } from 'vitest';
import { MockDataLayer } from '../../helpers/MockDataLayer.js';
import { RoomNotFoundError, AgentNotInRoomError, RoomAlreadyExistsError } from '../../../src/errors/index.js';

// Integration scenario test using all adapters together
class IntegratedScenario {
  constructor(private dataLayer: MockDataLayer) {}
  
  // Room operations
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
  
  // Messaging operations
  async sendMessage(params: { agentName: string; roomName: string; message: string }) {
    if (!this.dataLayer.roomExists(params.roomName)) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    const roomAgents = this.dataLayer.getRoomAgents(params.roomName);
    if (!roomAgents.includes(params.agentName)) {
      throw new AgentNotInRoomError(params.agentName, params.roomName);
    }
    
    const mentions = (params.message.match(/@(\w+)/g) || []).map(m => m.slice(1));
    
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      agentName: params.agentName,
      roomName: params.roomName,
      message: params.message,
      timestamp: new Date().toISOString(),
      mentions
    };
    
    this.dataLayer.addMessage(params.roomName, message);
    return { success: true, messageId: message.id, mentions };
  }
  
  async getMessages(params: { agentName: string; roomName: string; limit?: number; before?: string }) {
    if (!this.dataLayer.roomExists(params.roomName)) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    const roomAgents = this.dataLayer.getRoomAgents(params.roomName);
    if (!roomAgents.includes(params.agentName)) {
      throw new AgentNotInRoomError(params.agentName, params.roomName);
    }
    
    const messages = this.dataLayer.getMessages(params.roomName, params.limit, params.before);
    return { messages };
  }
  
  // Management operations
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
}

describe('Room-Messaging Flow Integration Tests', () => {
  let dataLayer: MockDataLayer;
  let scenario: IntegratedScenario;
  
  beforeEach(() => {
    dataLayer = new MockDataLayer();
    scenario = new IntegratedScenario(dataLayer);
  });
  
  describe('Complete workflow scenarios', () => {
    it('should handle basic room creation and messaging flow', async () => {
      // 1. Create room
      const createResult = await scenario.createRoom({
        roomName: 'team-standup',
        description: 'Daily standup meeting'
      });
      expect(createResult.success).toBe(true);
      
      // 2. Agents join room
      await scenario.enterRoom({ agentName: 'alice', roomName: 'team-standup' });
      await scenario.enterRoom({ agentName: 'bob', roomName: 'team-standup' });
      await scenario.enterRoom({ agentName: 'charlie', roomName: 'team-standup' });
      
      // 3. Verify room users
      const users = await scenario.listRoomUsers({ roomName: 'team-standup' });
      expect(users.agents).toHaveLength(3);
      expect(users.agents).toContain('alice');
      expect(users.agents).toContain('bob');
      expect(users.agents).toContain('charlie');
      
      // 4. Send messages
      const msg1 = await scenario.sendMessage({
        agentName: 'alice',
        roomName: 'team-standup',
        message: 'Good morning everyone! Ready for standup?'
      });
      expect(msg1.success).toBe(true);
      
      const msg2 = await scenario.sendMessage({
        agentName: 'bob',
        roomName: 'team-standup',
        message: 'Yes! @alice I finished the API work yesterday'
      });
      expect(msg2.mentions).toContain('alice');
      
      const msg3 = await scenario.sendMessage({
        agentName: 'charlie',
        roomName: 'team-standup',
        message: 'Great work @bob! I will review it today'
      });
      expect(msg3.mentions).toContain('bob');
      
      // 5. Retrieve messages
      const messages = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'team-standup'
      });
      
      expect(messages.messages).toHaveLength(3);
      expect(messages.messages[0].agentName).toBe('alice');
      expect(messages.messages[1].agentName).toBe('bob');
      expect(messages.messages[2].agentName).toBe('charlie');
      
      // 6. Check server status
      const status = await scenario.getStatus();
      expect(status.totalRooms).toBe(1);
      expect(status.totalMessages).toBe(3);
      expect(status.activeAgents).toBe(3);
      
      const room = status.rooms[0];
      expect(room.name).toBe('team-standup');
      expect(room.messageCount).toBe(3);
      expect(room.activeAgents).toBe(3);
    });
    
    it('should handle multi-room conversation flow', async () => {
      // Create multiple rooms
      await scenario.createRoom({ roomName: 'general', description: 'General discussion' });
      await scenario.createRoom({ roomName: 'dev-team', description: 'Development team' });
      await scenario.createRoom({ roomName: 'announcements', description: 'Company announcements' });
      
      // Agents join different rooms
      await scenario.enterRoom({ agentName: 'alice', roomName: 'general' });
      await scenario.enterRoom({ agentName: 'alice', roomName: 'dev-team' });
      await scenario.enterRoom({ agentName: 'bob', roomName: 'general' });
      await scenario.enterRoom({ agentName: 'bob', roomName: 'dev-team' });
      await scenario.enterRoom({ agentName: 'charlie', roomName: 'dev-team' });
      await scenario.enterRoom({ agentName: 'diana', roomName: 'announcements' });
      
      // Send messages to different rooms
      await scenario.sendMessage({
        agentName: 'alice',
        roomName: 'general',
        message: 'Hello everyone in general!'
      });
      
      await scenario.sendMessage({
        agentName: 'bob',
        roomName: 'dev-team',
        message: 'Dev team meeting at 3pm'
      });
      
      await scenario.sendMessage({
        agentName: 'diana',
        roomName: 'announcements',
        message: 'Company all-hands next Friday'
      });
      
      await scenario.sendMessage({
        agentName: 'charlie',
        roomName: 'dev-team',
        message: '@bob confirmed for 3pm meeting'
      });
      
      // Verify messages are isolated by room
      const generalMessages = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'general'
      });
      expect(generalMessages.messages).toHaveLength(1);
      expect(generalMessages.messages[0].message).toBe('Hello everyone in general!');
      
      const devMessages = await scenario.getMessages({
        agentName: 'bob',
        roomName: 'dev-team'
      });
      expect(devMessages.messages).toHaveLength(2);
      
      const announcementMessages = await scenario.getMessages({
        agentName: 'diana',
        roomName: 'announcements'
      });
      expect(announcementMessages.messages).toHaveLength(1);
      
      // Check overall status
      const status = await scenario.getStatus();
      expect(status.totalRooms).toBe(3);
      expect(status.totalMessages).toBe(4);
      expect(status.activeAgents).toBe(4); // alice, bob, charlie, diana
    });
    
    it('should handle agent lifecycle in rooms', async () => {
      await scenario.createRoom({ roomName: 'project-room', description: 'Project discussion' });
      
      // Agent joins and sends message
      await scenario.enterRoom({ agentName: 'alice', roomName: 'project-room' });
      await scenario.sendMessage({
        agentName: 'alice',
        roomName: 'project-room',
        message: 'Starting the project discussion'
      });
      
      // More agents join
      await scenario.enterRoom({ agentName: 'bob', roomName: 'project-room' });
      await scenario.enterRoom({ agentName: 'charlie', roomName: 'project-room' });
      
      // Conversation continues
      await scenario.sendMessage({
        agentName: 'bob',
        roomName: 'project-room',
        message: '@alice what are the requirements?'
      });
      
      await scenario.sendMessage({
        agentName: 'alice',
        roomName: 'project-room',
        message: '@bob I will share the specs in 5 minutes'
      });
      
      // Charlie leaves
      await scenario.leaveRoom({ agentName: 'charlie', roomName: 'project-room' });
      
      // Verify charlie can no longer send messages
      await expect(scenario.sendMessage({
        agentName: 'charlie',
        roomName: 'project-room',
        message: 'Can I still send messages?'
      })).rejects.toThrow(AgentNotInRoomError);
      
      // Verify charlie can no longer read messages
      await expect(scenario.getMessages({
        agentName: 'charlie',
        roomName: 'project-room'
      })).rejects.toThrow(AgentNotInRoomError);
      
      // Alice and Bob continue conversation
      await scenario.sendMessage({
        agentName: 'bob',
        roomName: 'project-room',
        message: 'Thanks @alice, looking forward to the specs'
      });
      
      // Check final state
      const users = await scenario.listRoomUsers({ roomName: 'project-room' });
      expect(users.agents).toHaveLength(2);
      expect(users.agents).toContain('alice');
      expect(users.agents).toContain('bob');
      expect(users.agents).not.toContain('charlie');
      
      const messages = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'project-room'
      });
      expect(messages.messages).toHaveLength(4);
    });
    
    it('should handle mention notifications across conversations', async () => {
      await scenario.createRoom({ roomName: 'notification-test', description: 'Testing mentions' });
      
      // Multiple agents join
      await scenario.enterRoom({ agentName: 'alice', roomName: 'notification-test' });
      await scenario.enterRoom({ agentName: 'bob', roomName: 'notification-test' });
      await scenario.enterRoom({ agentName: 'charlie', roomName: 'notification-test' });
      await scenario.enterRoom({ agentName: 'diana', roomName: 'notification-test' });
      
      // Send messages with various mention patterns
      const msg1 = await scenario.sendMessage({
        agentName: 'alice',
        roomName: 'notification-test',
        message: 'Hey @bob and @charlie, can you help with the project?'
      });
      expect(msg1.mentions).toEqual(['bob', 'charlie']);
      
      const msg2 = await scenario.sendMessage({
        agentName: 'bob',
        roomName: 'notification-test',
        message: '@alice sure! @diana do you want to join us?'
      });
      expect(msg2.mentions).toEqual(['alice', 'diana']);
      
      const msg3 = await scenario.sendMessage({
        agentName: 'charlie',
        roomName: 'notification-test',
        message: 'I am available. @alice @bob @diana let us schedule a meeting'
      });
      expect(msg3.mentions).toEqual(['alice', 'bob', 'diana']);
      
      // Send message with no mentions
      const msg4 = await scenario.sendMessage({
        agentName: 'diana',
        roomName: 'notification-test',
        message: 'Sounds good everyone, let me check my calendar'
      });
      expect(msg4.mentions).toEqual([]);
      
      // Verify all messages are stored with correct mentions
      const messages = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'notification-test'
      });
      
      expect(messages.messages).toHaveLength(4);
      expect(messages.messages[0].mentions).toEqual(['bob', 'charlie']);
      expect(messages.messages[1].mentions).toEqual(['alice', 'diana']);
      expect(messages.messages[2].mentions).toEqual(['alice', 'bob', 'diana']);
      expect(messages.messages[3].mentions).toEqual([]);
    });
  });
  
  describe('Error handling in workflows', () => {
    it('should handle errors gracefully without corrupting state', async () => {
      await scenario.createRoom({ roomName: 'error-test', description: 'Error handling test' });
      await scenario.enterRoom({ agentName: 'alice', roomName: 'error-test' });
      
      // Send valid message
      await scenario.sendMessage({
        agentName: 'alice',
        roomName: 'error-test',
        message: 'This message should work'
      });
      
      // Try to send message from non-member agent
      await expect(scenario.sendMessage({
        agentName: 'bob',
        roomName: 'error-test',
        message: 'This should fail'
      })).rejects.toThrow(AgentNotInRoomError);
      
      // Try to send message to non-existent room
      await expect(scenario.sendMessage({
        agentName: 'alice',
        roomName: 'non-existent',
        message: 'This should also fail'
      })).rejects.toThrow(RoomNotFoundError);
      
      // Verify original message is still there and state is consistent
      const messages = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'error-test'
      });
      expect(messages.messages).toHaveLength(1);
      expect(messages.messages[0].message).toBe('This message should work');
      
      const status = await scenario.getStatus();
      expect(status.totalMessages).toBe(1);
      expect(status.totalRooms).toBe(1);
    });
    
    it('should maintain consistency during concurrent operations', async () => {
      await scenario.createRoom({ roomName: 'concurrent-test', description: 'Concurrency test' });
      
      // Multiple agents join concurrently
      const joinPromises = ['alice', 'bob', 'charlie', 'diana', 'eve'].map(agent =>
        scenario.enterRoom({ agentName: agent, roomName: 'concurrent-test' })
      );
      
      await Promise.all(joinPromises);
      
      // Verify all agents joined
      const users = await scenario.listRoomUsers({ roomName: 'concurrent-test' });
      expect(users.agents).toHaveLength(5);
      
      // Send messages concurrently
      const messagePromises = ['alice', 'bob', 'charlie'].map((agent, index) =>
        scenario.sendMessage({
          agentName: agent,
          roomName: 'concurrent-test',
          message: `Concurrent message ${index + 1} from ${agent}`
        })
      );
      
      const messageResults = await Promise.all(messagePromises);
      messageResults.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
      });
      
      // Verify all messages were stored
      const messages = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'concurrent-test'
      });
      expect(messages.messages).toHaveLength(3);
      
      // Verify final state consistency
      const status = await scenario.getStatus();
      expect(status.totalMessages).toBe(3);
      expect(status.activeAgents).toBe(5);
    });
  });
  
  describe('Management operations in workflows', () => {
    it('should provide accurate status during complex operations', async () => {
      // Create multiple rooms and simulate activity
      await scenario.createRoom({ roomName: 'room1', description: 'First room' });
      await scenario.createRoom({ roomName: 'room2', description: 'Second room' });
      
      // Add agents to rooms
      await scenario.enterRoom({ agentName: 'alice', roomName: 'room1' });
      await scenario.enterRoom({ agentName: 'bob', roomName: 'room1' });
      await scenario.enterRoom({ agentName: 'bob', roomName: 'room2' });
      await scenario.enterRoom({ agentName: 'charlie', roomName: 'room2' });
      
      // Send messages
      await scenario.sendMessage({ agentName: 'alice', roomName: 'room1', message: 'Message 1' });
      await scenario.sendMessage({ agentName: 'bob', roomName: 'room1', message: 'Message 2' });
      await scenario.sendMessage({ agentName: 'bob', roomName: 'room2', message: 'Message 3' });
      
      let status = await scenario.getStatus();
      expect(status.totalRooms).toBe(2);
      expect(status.totalMessages).toBe(3);
      expect(status.activeAgents).toBe(3); // alice, bob, charlie
      
      // Clear messages in one room
      await scenario.clearRoomMessages({ roomName: 'room1' });
      
      status = await scenario.getStatus();
      expect(status.totalMessages).toBe(1); // only room2 message remains
      
      const room1 = status.rooms.find(r => r.name === 'room1');
      const room2 = status.rooms.find(r => r.name === 'room2');
      
      expect(room1?.messageCount).toBe(0);
      expect(room2?.messageCount).toBe(1);
      
      // Agents should still be in rooms after clearing messages
      expect(room1?.activeAgents).toBe(2);
      expect(room2?.activeAgents).toBe(2);
    });
    
    it('should handle message pagination in active conversations', async () => {
      await scenario.createRoom({ roomName: 'pagination-test', description: 'Testing pagination' });
      await scenario.enterRoom({ agentName: 'alice', roomName: 'pagination-test' });
      
      // Send many messages
      const messageIds = [];
      for (let i = 1; i <= 15; i++) {
        const result = await scenario.sendMessage({
          agentName: 'alice',
          roomName: 'pagination-test',
          message: `Message ${i}`
        });
        messageIds.push(result.messageId);
      }
      
      // Get first page (limit 5) - newest messages first
      const page1 = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'pagination-test',
        limit: 5
      });
      expect(page1.messages).toHaveLength(5);
      expect(page1.messages[0].message).toBe('Message 15');
      expect(page1.messages[4].message).toBe('Message 11');
      
      // Get second page using 'before' parameter
      const page2 = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'pagination-test',
        limit: 5,
        before: page1.messages[4].id
      });
      expect(page2.messages).toHaveLength(5);
      expect(page2.messages[0].message).toBe('Message 6');
      expect(page2.messages[4].message).toBe('Message 10');
      
      // Get remaining messages
      const page3 = await scenario.getMessages({
        agentName: 'alice',
        roomName: 'pagination-test',
        limit: 10,
        before: page2.messages[4].id
      });
      expect(page3.messages).toHaveLength(5); // only 5 remaining
      expect(page3.messages[0].message).toBe('Message 11');
      expect(page3.messages[4].message).toBe('Message 15');
    });
  });
});