import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageStorage } from '../../../src/features/messaging/MessageStorage';
import { StorageError } from '../../../src/errors/AppError';
import { GetMessagesParams } from '../../../src/features/messaging/types/messaging.types';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('MessageStorage', () => {
  let storage: MessageStorage;
  const testDataDir = './test-data-storage';

  beforeEach(() => {
    storage = new MessageStorage(testDataDir);
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('saveMessage', () => {
    it('should save message to JSONL file', async () => {
      const messageData = {
        id: '123e4567-e89b-42d3-a456-426614174000',
        agentName: 'test-agent',
        message: 'Hello world',
        timestamp: '2024-01-01T10:00:00.000Z',
        mentions: [],
        metadata: { priority: 'normal' }
      };

      await storage.saveMessage('test-room', messageData);

      const filePath = path.join(testDataDir, 'rooms', 'test-room', 'messages.jsonl');
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      
      expect(lines).toHaveLength(1);
      const savedMessage = JSON.parse(lines[0]);
      expect(savedMessage).toEqual(messageData);
    });

    it('should create directory if it does not exist', async () => {
      const messageData = {
        id: '123',
        agentName: 'test-agent',
        message: 'Hello',
        timestamp: '2024-01-01T10:00:00.000Z',
        mentions: []
      };

      await storage.saveMessage('new-room', messageData);

      const dirPath = path.join(testDataDir, 'rooms', 'new-room');
      const stat = await fs.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should append messages to existing file', async () => {
      const message1 = {
        id: '1',
        agentName: 'agent1',
        message: 'First message',
        timestamp: '2024-01-01T10:00:00.000Z',
        mentions: []
      };
      
      const message2 = {
        id: '2',
        agentName: 'agent2',
        message: 'Second message',
        timestamp: '2024-01-01T10:01:00.000Z',
        mentions: []
      };

      await storage.saveMessage('test-room', message1);
      await storage.saveMessage('test-room', message2);

      const filePath = path.join(testDataDir, 'rooms', 'test-room', 'messages.jsonl');
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(message1);
      expect(JSON.parse(lines[1])).toEqual(message2);
    });
  });

  describe('getMessages', () => {
    beforeEach(async () => {
      // Create test messages
      const messages = [
        {
          id: '1',
          agentName: 'alice',
          message: 'First message',
          timestamp: '2024-01-01T10:00:00.000Z',
          mentions: []
        },
        {
          id: '2',
          agentName: 'bob',
          message: 'Second message @alice',
          timestamp: '2024-01-01T10:01:00.000Z',
          mentions: ['alice']
        },
        {
          id: '3',
          agentName: 'charlie',
          message: 'Third message',
          timestamp: '2024-01-01T10:02:00.000Z',
          mentions: []
        }
      ];

      for (const message of messages) {
        await storage.saveMessage('test-room', message);
      }
    });

    it('should get messages with default parameters', async () => {
      const params: GetMessagesParams = {
        roomName: 'test-room'
      };

      const result = await storage.getMessages(params);

      expect(result.messages).toHaveLength(3);
      expect(result.hasMore).toBe(false);
      // Messages should be sorted by timestamp (newest first)
      expect(result.messages[0].id).toBe('3');
      expect(result.messages[1].id).toBe('2');
      expect(result.messages[2].id).toBe('1');
    });

    it('should apply limit to messages', async () => {
      const params: GetMessagesParams = {
        roomName: 'test-room',
        limit: 2
      };

      const result = await storage.getMessages(params);

      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.messages[0].id).toBe('3');
      expect(result.messages[1].id).toBe('2');
    });

    it('should apply offset to messages', async () => {
      const params: GetMessagesParams = {
        roomName: 'test-room',
        limit: 2,
        offset: 1
      };

      const result = await storage.getMessages(params);

      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.messages[0].id).toBe('2');
      expect(result.messages[1].id).toBe('1');
    });

    it('should filter messages by mentions', async () => {
      const params: GetMessagesParams = {
        roomName: 'test-room',
        agentName: 'alice',
        mentionsOnly: true
      };

      const result = await storage.getMessages(params);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Second message @alice');
    });

    it('should return empty result for non-existent room', async () => {
      const params: GetMessagesParams = {
        roomName: 'non-existent-room'
      };

      const result = await storage.getMessages(params);

      expect(result.messages).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('getMessageCount', () => {
    it('should return 0 for room with no messages', async () => {
      const count = await storage.getMessageCount('empty-room');
      expect(count).toBe(0);
    });

    it('should return correct count for room with messages', async () => {
      const messages = [
        { id: '1', agentName: 'agent1', message: 'msg1', timestamp: '2024-01-01T10:00:00.000Z', mentions: [] },
        { id: '2', agentName: 'agent2', message: 'msg2', timestamp: '2024-01-01T10:01:00.000Z', mentions: [] }
      ];

      for (const message of messages) {
        await storage.saveMessage('test-room', message);
      }

      const count = await storage.getMessageCount('test-room');
      expect(count).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should throw StorageError for directory creation failure', async () => {
      // Create a file where we expect a directory
      const invalidPath = path.join(testDataDir, 'rooms');
      await fs.mkdir(path.dirname(invalidPath), { recursive: true });
      await fs.writeFile(invalidPath, 'blocking file');

      const messageData = {
        id: '1',
        agentName: 'agent1',
        message: 'test',
        timestamp: '2024-01-01T10:00:00.000Z',
        mentions: []
      };

      await expect(storage.saveMessage('test-room', messageData))
        .rejects.toThrow(StorageError);
    });
  });
});