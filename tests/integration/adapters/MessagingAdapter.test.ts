import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDataLayer } from '../../helpers/MockDataLayer.js';
import { RoomNotFoundError, AgentNotInRoomError } from '../../../src/errors/index.js';

// Mock MessagingAdapter since it doesn't exist yet
class MockMessagingAdapter {
  constructor(private dataLayer: MockDataLayer) {}
  
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
}

describe('MessagingAdapter Integration Tests', () => {
  let dataLayer: MockDataLayer;
  let adapter: MockMessagingAdapter;
  
  beforeEach(() => {
    dataLayer = new MockDataLayer();
    adapter = new MockMessagingAdapter(dataLayer);
    
    // Setup test room and agent
    dataLayer.createRoom({
      name: 'test-room',
      description: 'Test room',
      createdAt: new Date().toISOString(),
      messageCount: 0
    });
    dataLayer.addAgentToRoom('test-room', 'agent1');
    dataLayer.addAgentToRoom('test-room', 'agent2');
  });
  
  describe('sendMessage', () => {
    it('should send message successfully when agent is in room', async () => {
      const result = await adapter.sendMessage({
        agentName: 'agent1',
        roomName: 'test-room',
        message: 'Hello everyone!'
      });
      
      expect(result.success).toBe(true);
      expect(result.messageId).toMatch(/^msg_\d+_[a-z0-9]+$/);
      expect(result.mentions).toEqual([]);
    });
    
    it('should extract mentions from message', async () => {
      const result = await adapter.sendMessage({
        agentName: 'agent1',
        roomName: 'test-room',
        message: 'Hello @agent2 and @agent3!'
      });
      
      expect(result.mentions).toEqual(['agent2', 'agent3']);
    });
    
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(adapter.sendMessage({
        agentName: 'agent1',
        roomName: 'non-existent',
        message: 'Hello!'
      })).rejects.toThrow(RoomNotFoundError);
    });
    
    it('should throw AgentNotInRoomError when agent not in room', async () => {
      await expect(adapter.sendMessage({
        agentName: 'agent3',
        roomName: 'test-room',
        message: 'Hello!'
      })).rejects.toThrow(AgentNotInRoomError);
    });
    
    it('should handle concurrent message sending', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        adapter.sendMessage({
          agentName: 'agent1',
          roomName: 'test-room',
          message: `Message ${i}`
        })
      );
      
      const results = await Promise.all(promises);
      
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
      });
      
      // Verify all messages were stored
      const messages = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room'
      });
      expect(messages.messages).toHaveLength(5);
    });
  });
  
  describe('getMessages', () => {
    beforeEach(async () => {
      // Send test messages
      for (let i = 1; i <= 10; i++) {
        await adapter.sendMessage({
          agentName: 'agent1',
          roomName: 'test-room',
          message: `Message ${i}`
        });
      }
    });
    
    it('should retrieve messages when agent is in room', async () => {
      const result = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room'
      });
      
      expect(result.messages).toHaveLength(10);
      expect(result.messages[0].message).toBe('Message 1');
      expect(result.messages[9].message).toBe('Message 10');
    });
    
    it('should limit number of messages returned', async () => {
      const result = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room',
        limit: 5
      });
      
      expect(result.messages).toHaveLength(5);
    });
    
    it('should support pagination with offset', async () => {
      const firstBatch = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room',
        limit: 5
      });
      
      const secondBatch = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room',
        limit: 5,
        offset: 5
      });
      
      expect(secondBatch.messages).toHaveLength(5);
      expect(secondBatch.messages[0].id).not.toBe(firstBatch.messages[0].id);
    });
    
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(adapter.getMessages({
        agentName: 'agent1',
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
    });
    
    it('should throw AgentNotInRoomError when agent not in room', async () => {
      await expect(adapter.getMessages({
        agentName: 'agent3',
        roomName: 'test-room'
      })).rejects.toThrow(AgentNotInRoomError);
    });
  });
  
  describe('message storage integration', () => {
    it('should maintain message order across multiple sends', async () => {
      const messages = ['First', 'Second', 'Third'];
      
      for (const msg of messages) {
        await adapter.sendMessage({
          agentName: 'agent1',
          roomName: 'test-room',
          message: msg
        });
      }
      
      const result = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room'
      });
      
      expect(result.messages.map(m => m.message)).toEqual(messages);
    });
    
    it('should persist mentions in stored messages', async () => {
      await adapter.sendMessage({
        agentName: 'agent1',
        roomName: 'test-room',
        message: 'Hey @agent2, check this out @agent3!'
      });
      
      const result = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room'
      });
      
      expect(result.messages[0].mentions).toEqual(['agent2', 'agent3']);
    });
    
    it('should handle empty messages gracefully', async () => {
      await expect(adapter.sendMessage({
        agentName: 'agent1',
        roomName: 'test-room',
        message: ''
      })).resolves.toBeDefined();
    });
  });
  
  describe('error handling and recovery', () => {
    it('should handle malformed mention patterns', async () => {
      const result = await adapter.sendMessage({
        agentName: 'agent1',
        roomName: 'test-room',
        message: 'Invalid @@ mention and valid @agent2'
      });
      
      expect(result.mentions).toEqual(['agent2']);
    });
    
    it('should maintain data consistency on errors', async () => {
      // Send valid message
      await adapter.sendMessage({
        agentName: 'agent1',
        roomName: 'test-room',
        message: 'Valid message'
      });
      
      // Attempt invalid operation
      try {
        await adapter.sendMessage({
          agentName: 'agent3',
          roomName: 'test-room',
          message: 'Should fail'
        });
      } catch (error) {
        // Expected to fail
      }
      
      // Verify original message still exists
      const result = await adapter.getMessages({
        agentName: 'agent1',
        roomName: 'test-room'
      });
      
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Valid message');
    });
  });
});