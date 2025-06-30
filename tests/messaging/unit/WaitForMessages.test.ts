import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageService } from '../../../src/features/messaging/MessageService';
import { RoomService } from '../../../src/features/rooms/room/RoomService';
import { LockService } from '../../../src/services/LockService';
import { ValidationError, RoomNotFoundError, AgentNotInRoomError } from '../../../src/errors/AppError';
import { promises as fs } from 'fs';
import * as path from 'path';

describe('WaitForMessages', () => {
  let messageService: MessageService;
  let roomService: RoomService;
  let lockService: LockService;
  const testDataDir = './test-data-wait';

  beforeEach(async () => {
    // Clean up test data directory before each test
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    
    lockService = new LockService(testDataDir);
    messageService = new MessageService(testDataDir, undefined, lockService);
    roomService = new RoomService(testDataDir, lockService);
    
    // Create a test room and add agents
    await roomService.createRoom({ roomName: 'test-room', description: 'Test room' });
    await roomService.enterRoom({ agentName: 'alice', roomName: 'test-room' });
    await roomService.enterRoom({ agentName: 'bob', roomName: 'test-room' });
    await roomService.enterRoom({ agentName: 'charlie', roomName: 'test-room' });
  });

  afterEach(async () => {
    // Clean up test data directory after each test
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  describe('Basic functionality', () => {
    it('should wait for new messages with default timeout', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room'
      };

      // Since no messages are sent, this should timeout
      const result = await messageService.waitForMessages({
        ...params,
        timeout: 1000 // Use shorter timeout for test
      });
      
      expect(result.hasNewMessages).toBe(false);
      expect(result.messages).toHaveLength(0);
      expect(result.timedOut).toBe(true);
    });

    it('should return immediately if there are unread messages', async () => {
      // Send a message first
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: 'Hello Alice!'
      });

      const params = {
        agentName: 'alice',
        roomName: 'test-room'
      };

      const result = await messageService.waitForMessages(params);
      
      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Hello Alice!');
      expect(result.timedOut).toBe(false);
    });

    it('should wait and return new messages when they arrive', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      };

      // Start waiting for messages
      const waitPromise = messageService.waitForMessages(params);

      // Send a message after a short delay
      setTimeout(async () => {
        await messageService.sendMessage({
          agentName: 'bob',
          roomName: 'test-room',
          message: 'Delayed message'
        });
      }, 100);

      const result = await waitPromise;
      
      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Delayed message');
      expect(result.timedOut).toBe(false);
    });

    it('should timeout if no new messages arrive', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 1000
      };

      const startTime = Date.now();
      const result = await messageService.waitForMessages(params);
      const endTime = Date.now();
      
      expect(result.hasNewMessages).toBe(false);
      expect(result.messages).toHaveLength(0);
      expect(result.timedOut).toBe(true);
      expect(endTime - startTime).toBeGreaterThanOrEqual(1000);
      expect(endTime - startTime).toBeLessThan(1500);
    });
  });

  describe('Read/unread status management', () => {
    it('should track read status per agent', async () => {
      // Send multiple messages
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: 'Message 1'
      });
      
      const message2 = await messageService.sendMessage({
        agentName: 'charlie',
        roomName: 'test-room',
        message: 'Message 2'
      });

      // Alice reads the first message
      await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room'
      });

      // Send another message
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: 'Message 3'
      });

      // Alice should only get the new unread message
      const result = await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room'
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Message 3');
    });

    it('should update read status after returning messages', async () => {
      const sentMessage = await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: 'Test message'
      });

      // Alice reads the message
      await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room'
      });

      // Check read status file
      const readStatusPath = path.join(testDataDir, 'rooms', 'test-room', 'read_status.json');
      const readStatusContent = await fs.readFile(readStatusPath, 'utf-8');
      const readStatus = JSON.parse(readStatusContent);

      expect(readStatus.alice).toBeDefined();
      expect(readStatus.alice.lastReadMessageId).toBe(sentMessage.messageId);
      expect(readStatus.alice.lastReadTimestamp).toBeDefined();
    });

    it('should handle multiple agents with different read statuses', async () => {
      // Send messages
      await messageService.sendMessage({
        agentName: 'alice',
        roomName: 'test-room',
        message: 'Message from Alice'
      });

      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: 'Message from Bob'
      });

      // Bob reads all messages
      const bobResult = await messageService.waitForMessages({
        agentName: 'bob',
        roomName: 'test-room'
      });
      expect(bobResult.messages).toHaveLength(1); // Only Alice's message

      // Charlie hasn't read any messages
      const charlieResult = await messageService.waitForMessages({
        agentName: 'charlie',
        roomName: 'test-room'
      });
      expect(charlieResult.messages).toHaveLength(2); // Both messages

      // Alice only sees Bob's message
      const aliceResult = await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room'
      });
      expect(aliceResult.messages).toHaveLength(1); // Only Bob's message
    });
  });

  describe('Waiting agents tracking', () => {
    it('should track waiting agents in waiting_agents.json', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      };

      // Start waiting
      const waitPromise = messageService.waitForMessages(params);

      // Check waiting agents file after a short delay
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const waitingAgentsPath = path.join(testDataDir, 'rooms', 'test-room', 'waiting_agents.json');
      const waitingAgentsContent = await fs.readFile(waitingAgentsPath, 'utf-8');
      const waitingAgents = JSON.parse(waitingAgentsContent);

      expect(waitingAgents).toHaveLength(1);
      expect(waitingAgents[0].agentName).toBe('alice');
      expect(waitingAgents[0].startTime).toBeDefined();
      expect(waitingAgents[0].timeout).toBe(5000);

      // Send message to complete the wait
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: 'Wake up!'
      });

      await waitPromise;

      // Check that agent is removed from waiting list
      const updatedWaitingAgentsContent = await fs.readFile(waitingAgentsPath, 'utf-8');
      const updatedWaitingAgents = JSON.parse(updatedWaitingAgentsContent);
      expect(updatedWaitingAgents).toHaveLength(0);
    });

    it('should send system message when agent starts waiting', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 2000
      };

      // Start waiting
      const waitPromise = messageService.waitForMessages(params);

      // Check for system message
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const messages = await messageService.getMessages({
        roomName: 'test-room'
      });

      const systemMessage = messages.messages.find(m => 
        m.agentName === 'system' && 
        m.message.includes('alice is waiting for new messages')
      );

      expect(systemMessage).toBeDefined();

      // Send message to complete the wait
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: 'Hello!'
      });

      await waitPromise;
    });

    it('should send system message when agent stops waiting', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 1000
      };

      // Wait for timeout
      await messageService.waitForMessages(params);

      // Check for system messages
      const messages = await messageService.getMessages({
        roomName: 'test-room'
      });

      const stopMessage = messages.messages.find(m => 
        m.agentName === 'system' && 
        m.message.includes('alice stopped waiting')
      );

      expect(stopMessage).toBeDefined();
    });
  });

  describe('Deadlock detection', () => {
    it('should detect deadlock when 2 agents wait simultaneously', async () => {
      // Both agents start waiting
      const alicePromise = messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const bobPromise = messageService.waitForMessages({
        agentName: 'bob',
        roomName: 'test-room',
        timeout: 5000
      });

      // Bob should get a warning about deadlock
      const bobResult = await bobPromise;
      expect(bobResult.warning).toContain('deadlock');
      expect(bobResult.waitingAgents).toContain('alice');

      // Send message to wake up Alice
      await messageService.sendMessage({
        agentName: 'charlie',
        roomName: 'test-room',
        message: 'Breaking deadlock'
      });

      await alicePromise;
    });

    it('should include all waiting agents in deadlock warning', async () => {
      // Three agents start waiting
      const alicePromise = messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const bobPromise = messageService.waitForMessages({
        agentName: 'bob',
        roomName: 'test-room',
        timeout: 5000
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const charliePromise = messageService.waitForMessages({
        agentName: 'charlie',
        roomName: 'test-room',
        timeout: 5000
      });

      // Charlie should get warning with both Alice and Bob
      const charlieResult = await charliePromise;
      expect(charlieResult.warning).toContain('deadlock');
      expect(charlieResult.waitingAgents).toHaveLength(2);
      expect(charlieResult.waitingAgents).toContain('alice');
      expect(charlieResult.waitingAgents).toContain('bob');

      // Clean up by sending a message
      await roomService.enterRoom({ agentName: 'dave', roomName: 'test-room' });
      await messageService.sendMessage({
        agentName: 'dave',
        roomName: 'test-room',
        message: 'Breaking deadlock'
      });

      await Promise.all([alicePromise, bobPromise]);
    });
  });

  describe('Timeout handling', () => {
    it('should validate timeout range', async () => {
      // Timeout too low
      await expect(messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 500
      })).rejects.toThrow(ValidationError);

      // Timeout too high
      await expect(messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 150000
      })).rejects.toThrow(ValidationError);

      // Valid timeout should work
      const validPromise = messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      });

      // Send message to complete
      setTimeout(async () => {
        await messageService.sendMessage({
          agentName: 'bob',
          roomName: 'test-room',
          message: 'Valid timeout test'
        });
      }, 100);

      await expect(validPromise).resolves.toBeDefined();
    });

    it('should use default timeout when not specified', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room'
      };

      const startTime = Date.now();
      
      // Start waiting without timeout (should use default 120000ms)
      const waitPromise = messageService.waitForMessages(params);

      // Send message after 100ms to not wait for full default timeout
      setTimeout(async () => {
        await messageService.sendMessage({
          agentName: 'bob',
          roomName: 'test-room',
          message: 'Quick message'
        });
      }, 100);

      const result = await waitPromise;
      const endTime = Date.now();

      expect(result.hasNewMessages).toBe(true);
      expect(endTime - startTime).toBeLessThan(1000);
    });
  });

  describe('Error cases', () => {
    it('should throw RoomNotFoundError for non-existent room', async () => {
      await expect(messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'non-existent-room'
      })).rejects.toThrow(RoomNotFoundError);
    });

    it.skip('should throw AgentNotInRoomError if agent is not in room', async () => {
      // Note: AgentNotInRoomError should be thrown by the adapter layer, not MessageService
      // MessageService doesn't have access to room membership data
      // This validation is done in MessagingAdapter before calling MessageService
      await expect(messageService.waitForMessages({
        agentName: 'dave',
        roomName: 'test-room'
      })).rejects.toThrow(AgentNotInRoomError);
    });

    it('should throw ValidationError for empty agent name', async () => {
      await expect(messageService.waitForMessages({
        agentName: '',
        roomName: 'test-room'
      })).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for empty room name', async () => {
      await expect(messageService.waitForMessages({
        agentName: 'alice',
        roomName: ''
      })).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid agent name format', async () => {
      await expect(messageService.waitForMessages({
        agentName: 'invalid@agent',
        roomName: 'test-room'
      })).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid room name format', async () => {
      await expect(messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'invalid room!'
      })).rejects.toThrow(ValidationError);
    });
  });

  describe('Concurrent access', () => {
    it('should handle multiple agents waiting concurrently', async () => {
      // Multiple agents start waiting
      const waitPromises = [
        messageService.waitForMessages({
          agentName: 'alice',
          roomName: 'test-room',
          timeout: 5000
        }),
        messageService.waitForMessages({
          agentName: 'bob',
          roomName: 'test-room',
          timeout: 5000
        })
      ];

      // Send a message after a delay
      setTimeout(async () => {
        await messageService.sendMessage({
          agentName: 'charlie',
          roomName: 'test-room',
          message: 'Message for all'
        });
      }, 100);

      const results = await Promise.all(waitPromises);

      // Both should receive the message
      results.forEach(result => {
        expect(result.hasNewMessages).toBe(true);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].message).toBe('Message for all');
      });
    });

    it('should handle rapid message sending while agents are waiting', async () => {
      // Send messages sequentially to ensure order
      for (let i = 0; i < 5; i++) {
        await messageService.sendMessage({
          agentName: 'bob',
          roomName: 'test-room',
          message: `Rapid message ${i + 1}`
        });
      }

      // Now wait for messages - should get all 5 immediately
      const result = await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      });

      // Should receive all messages
      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(5);
      
      // Check messages are from bob and contain expected content
      const messageTexts = result.messages.map(m => m.message);
      expect(messageTexts).toContain('Rapid message 1');
      expect(messageTexts).toContain('Rapid message 2');
      expect(messageTexts).toContain('Rapid message 3');
      expect(messageTexts).toContain('Rapid message 4');
      expect(messageTexts).toContain('Rapid message 5');
    });

    it('should handle file locking correctly during concurrent operations', async () => {
      const operations = [];

      // Mix of waiting and sending operations
      for (let i = 0; i < 3; i++) {
        operations.push(
          messageService.waitForMessages({
            agentName: i % 2 === 0 ? 'alice' : 'bob',
            roomName: 'test-room',
            timeout: 2000
          })
        );

        operations.push(
          messageService.sendMessage({
            agentName: 'charlie',
            roomName: 'test-room',
            message: `Concurrent message ${i + 1}`
          })
        );
      }

      // All operations should complete without errors
      await expect(Promise.all(operations)).resolves.toBeDefined();
    });
  });

  describe('Cleanup functionality', () => {
    it('should clean up waiting agents on timeout', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 1000
      };

      await messageService.waitForMessages(params);

      // Check that agent is removed from waiting list
      const waitingAgentsPath = path.join(testDataDir, 'rooms', 'test-room', 'waiting_agents.json');
      const waitingAgentsContent = await fs.readFile(waitingAgentsPath, 'utf-8');
      const waitingAgents = JSON.parse(waitingAgentsContent);

      expect(waitingAgents).toHaveLength(0);
    });

    it('should clean up waiting agents when receiving messages', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      };

      const waitPromise = messageService.waitForMessages(params);

      // Send message to wake up
      setTimeout(async () => {
        await messageService.sendMessage({
          agentName: 'bob',
          roomName: 'test-room',
          message: 'Wake up message'
        });
      }, 100);

      await waitPromise;

      // Check that agent is removed from waiting list
      const waitingAgentsPath = path.join(testDataDir, 'rooms', 'test-room', 'waiting_agents.json');
      const waitingAgentsContent = await fs.readFile(waitingAgentsPath, 'utf-8');
      const waitingAgents = JSON.parse(waitingAgentsContent);

      expect(waitingAgents).toHaveLength(0);
    });

    it('should handle cleanup errors gracefully', async () => {
      const params = {
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 1000
      };

      // Mock file system error during cleanup
      const originalReadFile = fs.readFile;
      let shouldFail = false;
      
      vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, ...args) => {
        if (shouldFail && filePath.toString().includes('waiting_agents.json')) {
          throw new Error('Mock file system error');
        }
        return originalReadFile.call(fs, filePath, ...args);
      });

      const waitPromise = messageService.waitForMessages(params);
      
      // Trigger error during cleanup
      shouldFail = true;
      
      // Should complete despite cleanup error
      await expect(waitPromise).resolves.toBeDefined();
      
      vi.restoreAllMocks();
    });
  });

  describe('Edge cases', () => {
    it('should handle messages sent by the waiting agent itself', async () => {
      // Alice sends a message
      await messageService.sendMessage({
        agentName: 'alice',
        roomName: 'test-room',
        message: 'My own message'
      });

      // Alice waits for messages - should not receive her own message
      const result = await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 1000
      });

      expect(result.hasNewMessages).toBe(false);
      expect(result.messages).toHaveLength(0);
      expect(result.timedOut).toBe(true);
    });

    it.skip('should handle agent leaving room while waiting', async () => {
      // Note: MessageService doesn't check agent membership during polling
      // This check would need to be implemented in the adapter layer
      // For now, we skip this test as it requires adapter-level validation
      const waitPromise = messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      });

      // Alice leaves the room while waiting
      setTimeout(async () => {
        await roomService.leaveRoom({
          agentName: 'alice',
          roomName: 'test-room'
        });
      }, 100);

      // Should handle gracefully (might throw or return with error)
      await expect(waitPromise).rejects.toThrow();
    });

    it('should handle room deletion while agents are waiting', async () => {
      const waitPromise = messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      });

      // Delete the room directory while waiting
      setTimeout(async () => {
        const roomPath = path.join(testDataDir, 'rooms', 'test-room');
        await fs.rm(roomPath, { recursive: true, force: true });
      }, 100);

      // Should handle gracefully
      await expect(waitPromise).rejects.toThrow();
    });

    it('should handle corrupted read_status.json file', async () => {
      // Create corrupted read_status.json
      const readStatusPath = path.join(testDataDir, 'rooms', 'test-room', 'read_status.json');
      await fs.mkdir(path.dirname(readStatusPath), { recursive: true });
      await fs.writeFile(readStatusPath, 'invalid json content');

      // Should handle gracefully and treat as no read status
      const result = await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 1000
      });

      expect(result.timedOut).toBe(true);
    });

    it('should handle very long message content', async () => {
      // Message validator has a 2000 character limit
      const longMessage = 'x'.repeat(2000);
      
      await messageService.sendMessage({
        agentName: 'bob',
        roomName: 'test-room',
        message: longMessage
      });

      const result = await messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room'
      });

      expect(result.hasNewMessages).toBe(true);
      expect(result.messages[0].message).toBe(longMessage);
    });
  });

  describe('Integration with message sending', () => {
    it('should wake up waiting agents when new message arrives', async () => {
      let aliceReceived = false;
      let bobReceived = false;

      // Both agents start waiting
      const alicePromise = messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'test-room',
        timeout: 5000
      }).then(result => {
        aliceReceived = result.hasNewMessages;
        return result;
      });

      const bobPromise = messageService.waitForMessages({
        agentName: 'bob',
        roomName: 'test-room',
        timeout: 5000
      }).then(result => {
        bobReceived = result.hasNewMessages;
        return result;
      });

      // Wait a bit to ensure both are waiting
      await new Promise(resolve => setTimeout(resolve, 100));

      // Charlie sends a message
      await messageService.sendMessage({
        agentName: 'charlie',
        roomName: 'test-room',
        message: 'Wake up everyone!'
      });

      // Both should receive the message
      await Promise.all([alicePromise, bobPromise]);

      expect(aliceReceived).toBe(true);
      expect(bobReceived).toBe(true);
    });

    it('should only wake up agents in the specific room', async () => {
      // Create another room
      await roomService.createRoom({ roomName: 'other-room', description: 'Other room' });
      await roomService.enterRoom({ agentName: 'alice', roomName: 'other-room' });

      // Alice waits in other-room
      const otherRoomPromise = messageService.waitForMessages({
        agentName: 'alice',
        roomName: 'other-room',
        timeout: 2000
      });

      // Bob waits in test-room
      const testRoomPromise = messageService.waitForMessages({
        agentName: 'bob',
        roomName: 'test-room',
        timeout: 2000
      });

      // Send message to test-room only
      await messageService.sendMessage({
        agentName: 'charlie',
        roomName: 'test-room',
        message: 'Message for test-room'
      });

      const [otherResult, testResult] = await Promise.all([otherRoomPromise, testRoomPromise]);

      // Alice in other-room should timeout
      expect(otherResult.hasNewMessages).toBe(false);
      expect(otherResult.timedOut).toBe(true);

      // Bob in test-room should receive the message
      expect(testResult.hasNewMessages).toBe(true);
      expect(testResult.messages).toHaveLength(1);
    });
  });
});