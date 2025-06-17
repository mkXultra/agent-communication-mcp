import { describe, it, expect, beforeEach } from 'vitest';
import { LockService } from '../../src/services/LockService';
import { MessagingAdapter } from '../../src/adapters/MessagingAdapter';
import { RoomsAdapter } from '../../src/adapters/RoomsAdapter';
import { ManagementAdapter } from '../../src/adapters/ManagementAdapter';
import './setup';

describe('Integration: Full Flow Test', () => {
  let lockService: LockService;
  let messagingAdapter: MessagingAdapter;
  let roomsAdapter: RoomsAdapter;
  let managementAdapter: ManagementAdapter;

  beforeEach(async () => {
    // Initialize services
    lockService = new LockService();
    messagingAdapter = new MessagingAdapter(lockService);
    roomsAdapter = new RoomsAdapter(lockService);
    managementAdapter = new ManagementAdapter(lockService);

    // Set up cross-adapter dependencies
    messagingAdapter.setRoomsAdapter(roomsAdapter);
    managementAdapter.setRoomsAdapter(roomsAdapter);
    managementAdapter.setMessageAdapter(messagingAdapter);

    // Initialize adapters
    await Promise.all([
      messagingAdapter.initialize(),
      roomsAdapter.initialize(),
      managementAdapter.initialize()
    ]);
  });

  describe('Complete Room Lifecycle', () => {
    const roomName = 'test-room';
    const agentName = 'test-agent';
    const messageContent = 'Hello, this is a test message!';

    it('should create room, join, send message, and get status', async () => {
      // 1. Create a room
      const createResult = await roomsAdapter.createRoom({
        roomName,
        description: 'Test room for integration testing'
      });
      expect(createResult.success).toBe(true);
      expect(createResult.roomName).toBe(roomName);

      // 2. List rooms to verify creation
      const roomsList = await roomsAdapter.listRooms();
      expect(roomsList.rooms).toHaveLength(1);
      expect(roomsList.rooms[0].name).toBe(roomName);

      // 3. Join the room
      const joinResult = await roomsAdapter.enterRoom({
        agentName,
        roomName,
        profile: {
          role: 'tester',
          description: 'Integration test agent'
        }
      });
      expect(joinResult.success).toBe(true);

      // 4. List room users
      const usersResult = await roomsAdapter.listRoomUsers({ roomName });
      expect(usersResult.users).toHaveLength(1);
      expect(usersResult.users[0].name).toBe(agentName);

      // 5. Send a message
      const sendResult = await messagingAdapter.sendMessage({
        agentName,
        roomName,
        message: messageContent
      });
      expect(sendResult.success).toBe(true);
      expect(sendResult.messageId).toBeDefined();

      // 6. Get messages
      const messagesResult = await messagingAdapter.getMessages({
        roomName,
        limit: 10
      });
      expect(messagesResult.messages).toHaveLength(1);
      expect(messagesResult.messages[0].message).toBe(messageContent);
      expect(messagesResult.messages[0].agentName).toBe(agentName);

      // 7. Get system status
      const statusResult = await managementAdapter.getStatus();
      expect(statusResult.totalRooms).toBe(1);
      expect(statusResult.totalMessages).toBe(1);
      expect(statusResult.rooms[0].name).toBe(roomName);

      // 8. Leave room
      const leaveResult = await roomsAdapter.leaveRoom({
        agentName,
        roomName
      });
      expect(leaveResult.success).toBe(true);

      // 9. Clear messages
      const clearResult = await managementAdapter.clearRoomMessages({
        roomName,
        confirm: true
      });
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedCount).toBe(1);
    });
  });

  describe('Multi-Agent Interaction', () => {
    const roomName = 'multi-agent-room';
    const agent1 = 'agent-alpha';
    const agent2 = 'agent-beta';

    it('should handle multiple agents with mentions', async () => {
      // Create room
      await roomsAdapter.createRoom({ roomName });

      // Both agents join
      await roomsAdapter.enterRoom({ agentName: agent1, roomName });
      await roomsAdapter.enterRoom({ agentName: agent2, roomName });

      // Agent1 mentions Agent2
      const messageWithMention = `Hey @${agent2}, can you help with this?`;
      const sendResult = await messagingAdapter.sendMessage({
        agentName: agent1,
        roomName,
        message: messageWithMention
      });

      expect(sendResult.mentions).toContain(agent2);

      // Agent2 checks messages with mention filter
      const messagesResult = await messagingAdapter.getMessages({
        agentName: agent2,
        roomName,
        mentionsOnly: true
      });

      expect(messagesResult.messages).toHaveLength(1);
      expect(messagesResult.messages[0].mentions).toContain(agent2);
    });
  });

  describe('Error Handling', () => {
    it('should handle room not found errors', async () => {
      await expect(
        messagingAdapter.sendMessage({
          agentName: 'test-agent',
          roomName: 'non-existent-room',
          message: 'test'
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should handle agent not in room errors', async () => {
      const roomName = 'error-test-room';
      await roomsAdapter.createRoom({ roomName });

      await expect(
        messagingAdapter.sendMessage({
          agentName: 'not-joined-agent',
          roomName,
          message: 'test'
        })
      ).rejects.toThrow(/not in room/i);
    });

    it('should handle duplicate room creation', async () => {
      const roomName = 'duplicate-test';
      await roomsAdapter.createRoom({ roomName });

      await expect(
        roomsAdapter.createRoom({ roomName })
      ).rejects.toThrow(/already exists/i);
    });
  });
});