import { describe, it, expect, beforeEach } from 'vitest';
import { MessageService } from '../../../src/features/messaging/MessageService';
import { RoomNotFoundError, ValidationError } from '../../../src/errors/AppError';

describe('MessageService', () => {
  let messageService: MessageService;

  beforeEach(async () => {
    // Clean up test data directory before each test
    const fs = await import('fs/promises');
    try {
      await fs.rm('./test-data-message-service', { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    
    // Create the test data directory and rooms/general directory
    await fs.mkdir('./test-data-message-service/rooms/general', { recursive: true });
    
    messageService = new MessageService('./test-data-message-service');
  });

  describe('sendMessage', () => {
    it('should send a message successfully', async () => {
      const params = {
        agentName: 'test-agent',
        roomName: 'general',
        message: 'Hello world!'
      };

      const result = await messageService.sendMessage(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(result.roomName).toBe('general');
      expect(result.timestamp).toBeDefined();
      expect(result.mentions).toEqual([]);
    });

    it('should extract mentions from message', async () => {
      const params = {
        agentName: 'test-agent',
        roomName: 'general',
        message: 'Hello @alice and @bob!'
      };

      const result = await messageService.sendMessage(params);

      expect(result.success).toBe(true);
      expect(result.mentions).toEqual(['alice', 'bob']);
    });

    it('should include metadata in message', async () => {
      const params = {
        agentName: 'test-agent',
        roomName: 'general',
        message: 'Hello world!',
        metadata: { priority: 'high' }
      };

      const result = await messageService.sendMessage(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should throw ValidationError for invalid parameters', async () => {
      const params = {
        agentName: '',
        roomName: 'general',
        message: 'Hello world!'
      };

      await expect(messageService.sendMessage(params)).rejects.toThrow(ValidationError);
    });
  });

  describe('getMessages', () => {
    beforeEach(async () => {
      // Send some test messages first
      await messageService.sendMessage({
        agentName: 'alice',
        roomName: 'general',
        message: 'First message'
      });
      
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'general',
        message: 'Second message @alice'
      });
      
      await messageService.sendMessage({
        agentName: 'charlie',
        roomName: 'general',
        message: 'Third message'
      });
    });

    it('should get messages from room', async () => {
      const params = {
        roomName: 'general'
      };

      const result = await messageService.getMessages(params);

      expect(result.roomName).toBe('general');
      expect(result.messages).toHaveLength(3);
      expect(result.count).toBe(3);
      expect(result.hasMore).toBe(false);
    });

    it('should apply limit to messages', async () => {
      const params = {
        roomName: 'general',
        limit: 2
      };

      const result = await messageService.getMessages(params);

      expect(result.messages).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.hasMore).toBe(true);
    });

    it('should apply offset to messages', async () => {
      const params = {
        roomName: 'general',
        limit: 2,
        offset: 1
      };

      const result = await messageService.getMessages(params);

      expect(result.messages).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it('should filter messages by mentions', async () => {
      const params = {
        roomName: 'general',
        agentName: 'alice',
        mentionsOnly: true
      };

      const result = await messageService.getMessages(params);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Second message @alice');
    });

    it('should return empty result for room with no messages', async () => {
      const params = {
        roomName: 'empty-room'
      };

      const result = await messageService.getMessages(params);

      expect(result.messages).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('getMessageCount', () => {
    it('should return 0 for room with no messages', async () => {
      const count = await messageService.getMessageCount('general');
      expect(count).toBe(0);
    });

    it('should return correct count after sending messages', async () => {
      await messageService.sendMessage({
        agentName: 'alice',
        roomName: 'general',
        message: 'First message'
      });
      
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'general',
        message: 'Second message'
      });

      const count = await messageService.getMessageCount('general');
      expect(count).toBe(2);
    });
  });
});