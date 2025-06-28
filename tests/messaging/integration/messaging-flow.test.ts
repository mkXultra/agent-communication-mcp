import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessagingAPI } from '../../../src/features/messaging';
import * as fs from 'fs/promises';

describe('Messaging Integration Tests', () => {
  let messagingAPI: MessagingAPI;
  const testDataDir = './test-data-integration';

  beforeEach(() => {
    messagingAPI = new MessagingAPI(testDataDir);
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Complete messaging flow', () => {
    it('should handle complete send -> receive flow', async () => {
      // Send multiple messages
      const messages = [
        { agentName: 'alice', message: 'Hello everyone!' },
        { agentName: 'bob', message: 'Hi @alice, how are you?' },
        { agentName: 'charlie', message: 'Good morning @alice and @bob' },
        { agentName: 'alice', message: 'Great, thanks @bob!' }
      ];

      const sendResults = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Add small delay to ensure different timestamps
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 10));
        
        const result = await messagingAPI.sendMessage({
          ...msg,
          roomName: 'integration-test',
          metadata: { source: 'integration-test' }
        });
        sendResults.push(result);
      }

      // Verify all sends succeeded
      sendResults.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
        expect(result.timestamp).toBeDefined();
      });

      // Retrieve all messages
      const allMessages = await messagingAPI.getMessages({
        roomName: 'integration-test'
      });

      expect(allMessages.messages).toHaveLength(4);
      expect(allMessages.count).toBe(4);
      expect(allMessages.hasMore).toBe(false);

      // Verify message order (newest first)
      expect(allMessages.messages[0].agentName).toBe('alice');
      expect(allMessages.messages[0].message).toBe('Great, thanks @bob!');

      // Verify mentions were extracted correctly
      expect(sendResults[1].mentions).toEqual(['alice']);
      expect(sendResults[2].mentions).toEqual(['alice', 'bob']);
      expect(sendResults[3].mentions).toEqual(['bob']);
    });

    it('should handle pagination correctly', async () => {
      // Send 25 messages
      for (let i = 0; i < 25; i++) {
        await messagingAPI.sendMessage({
          agentName: `agent${i % 5}`,
          roomName: 'integration-test',
          message: `Message ${i}`
        });
      }

      // Get first page
      const page1 = await messagingAPI.getMessages({
        roomName: 'integration-test',
        limit: 10,
        offset: 0
      });

      expect(page1.messages).toHaveLength(10);
      expect(page1.count).toBe(10);
      expect(page1.hasMore).toBe(true);

      // Get second page
      const page2 = await messagingAPI.getMessages({
        roomName: 'integration-test',
        limit: 10,
        offset: 10
      });

      expect(page2.messages).toHaveLength(10);
      expect(page2.count).toBe(10);
      expect(page2.hasMore).toBe(true);

      // Get last page
      const page3 = await messagingAPI.getMessages({
        roomName: 'integration-test',
        limit: 10,
        offset: 20
      });

      expect(page3.messages).toHaveLength(5);
      expect(page3.count).toBe(5);
      expect(page3.hasMore).toBe(false);

      // Verify no overlap between pages
      const allIds = [
        ...page1.messages.map(m => m.id),
        ...page2.messages.map(m => m.id),
        ...page3.messages.map(m => m.id)
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(25);
    });

    it('should handle mentions filtering correctly', async () => {
      // Send messages with various mention patterns
      const testMessages = [
        { agentName: 'alice', message: 'Hello everyone!', mentions: [] },
        { agentName: 'bob', message: 'Hi @alice', mentions: ['alice'] },
        { agentName: 'charlie', message: 'Hey @alice and @david', mentions: ['alice', 'david'] },
        { agentName: 'david', message: 'Thanks @charlie', mentions: ['charlie'] },
        { agentName: 'eve', message: 'Good morning @alice', mentions: ['alice'] }
      ];

      for (const msg of testMessages) {
        await messagingAPI.sendMessage({
          agentName: msg.agentName,
          roomName: 'integration-test',
          message: msg.message
        });
      }

      // Get all messages mentioning alice
      const aliceMentions = await messagingAPI.getMessages({
        roomName: 'integration-test',
        agentName: 'alice',
        mentionsOnly: true
      });

      expect(aliceMentions.messages).toHaveLength(3);
      aliceMentions.messages.forEach(msg => {
        expect(msg.mentions).toContain('alice');
      });

      // Get all messages mentioning charlie
      const charlieMentions = await messagingAPI.getMessages({
        roomName: 'integration-test',
        agentName: 'charlie',
        mentionsOnly: true
      });

      expect(charlieMentions.messages).toHaveLength(1);
      expect(charlieMentions.messages[0].message).toBe('Thanks @charlie');
    });

    it('should handle multiple rooms independently', async () => {
      // Send messages to different rooms
      await messagingAPI.sendMessage({
        agentName: 'alice',
        roomName: 'integration-test',
        message: 'Message in room 1'
      });

      await messagingAPI.sendMessage({
        agentName: 'bob',
        roomName: 'team-chat',
        message: 'Message in room 2'
      });

      await messagingAPI.sendMessage({
        agentName: 'charlie',
        roomName: 'integration-test',
        message: 'Another message in room 1'
      });

      // Verify room 1 has 2 messages
      const room1Messages = await messagingAPI.getMessages({
        roomName: 'integration-test'
      });
      expect(room1Messages.messages).toHaveLength(2);

      // Verify room 2 has 1 message
      const room2Messages = await messagingAPI.getMessages({
        roomName: 'team-chat'
      });
      expect(room2Messages.messages).toHaveLength(1);

      // Verify message counts
      const room1Count = await messagingAPI.getMessageCount('integration-test');
      const room2Count = await messagingAPI.getMessageCount('team-chat');

      expect(room1Count).toBe(2);
      expect(room2Count).toBe(1);
    });
  });

  describe('Error handling integration', () => {
    it('should handle invalid room names consistently', async () => {
      // MessagingAPI doesn't validate room existence - it creates messages regardless
      // This is the expected behavior as MessagingAPI is a lower-level service
      const result = await messagingAPI.sendMessage({
        agentName: 'alice',
        roomName: 'non-existent-room',
        message: 'Test message'
      });
      
      expect(result.success).toBe(true);
      expect(result.roomName).toBe('non-existent-room');

      // Getting messages from non-existent room should return empty result
      const messages = await messagingAPI.getMessages({
        roomName: 'non-existent-room'
      });
      expect(messages.messages).toHaveLength(1); // The message we just sent

      // getMessageCount should return 1 for the message we just sent
      const messageCount = await messagingAPI.getMessageCount('non-existent-room');
      expect(messageCount).toBe(1);
    });

    it('should handle validation errors consistently', async () => {
      // Invalid agent name
      await expect(messagingAPI.sendMessage({
        agentName: '',
        roomName: 'integration-test',
        message: 'Test message'
      })).rejects.toThrow();

      // Invalid room name format
      await expect(messagingAPI.sendMessage({
        agentName: 'alice',
        roomName: 'invalid room!',
        message: 'Test message'
      })).rejects.toThrow();

      // Invalid message (empty)
      await expect(messagingAPI.sendMessage({
        agentName: 'alice',
        roomName: 'integration-test',
        message: ''
      })).rejects.toThrow();

      // Invalid message (too long)
      await expect(messagingAPI.sendMessage({
        agentName: 'alice',
        roomName: 'integration-test',
        message: 'x'.repeat(1001)
      })).rejects.toThrow();
    });
  });
});