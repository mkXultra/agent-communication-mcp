import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { LockService } from '../../../src/services/LockService.js';
import { MessagingAdapter } from '../../../src/adapters/MessagingAdapter.js';
import { RoomsAdapter } from '../../../src/adapters/RoomsAdapter.js';
import { ManagementAdapter } from '../../../src/adapters/ManagementAdapter.js';
import { RoomNotFoundError, AgentNotInRoomError, RoomAlreadyExistsError } from '../../../src/errors/index.js';

describe('Real Adapters Integration Tests', () => {
  let testDataDir: string;
  let lockService: LockService;
  let messagingAdapter: MessagingAdapter;
  let roomsAdapter: RoomsAdapter;
  let managementAdapter: ManagementAdapter;
  
  beforeEach(async () => {
    // Create temporary test directory
    testDataDir = path.join(process.cwd(), 'test-data-' + Date.now());
    await fs.mkdir(testDataDir, { recursive: true });
    
    // Set environment variable to use our test directory
    process.env.AGENT_COMM_DATA_DIR = testDataDir;
    
    // Initialize services
    lockService = new LockService(testDataDir);
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
  
  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    
    // Clean up environment variable
    delete process.env.AGENT_COMM_DATA_DIR;
  });
  
  describe('Rooms Adapter with Real Implementation', () => {
    it('should create and list rooms', async () => {
      // Initially no rooms
      const initialRooms = await roomsAdapter.listRooms();
      expect(initialRooms.rooms).toEqual([]);
      
      // Create room
      const createResult = await roomsAdapter.createRoom({
        roomName: 'test-room',
        description: 'A test room'
      });
      
      expect(createResult.success).toBe(true);
      expect(createResult.roomName).toBe('test-room');
      
      // List rooms should now include the new room
      const rooms = await roomsAdapter.listRooms();
      expect(rooms.rooms).toHaveLength(1);
      expect(rooms.rooms[0].name).toBe('test-room');
      expect(rooms.rooms[0].description).toBe('A test room');
    });
    
    it('should handle agent room membership', async () => {
      // Create room
      await roomsAdapter.createRoom({ roomName: 'membership-test' });
      
      // Initially no users
      const initialUsers = await roomsAdapter.listRoomUsers({ roomName: 'membership-test' });
      expect(initialUsers.agents).toEqual([]);
      
      // Agent enters room
      const enterResult = await roomsAdapter.enterRoom({
        agentName: 'agent1',
        roomName: 'membership-test'
      });
      expect(enterResult.success).toBe(true);
      
      // Verify agent is in room
      const users = await roomsAdapter.listRoomUsers({ roomName: 'membership-test' });
      expect(users.agents).toContain('agent1');
      
      // Agent leaves room
      const leaveResult = await roomsAdapter.leaveRoom({
        agentName: 'agent1',
        roomName: 'membership-test'
      });
      expect(leaveResult.success).toBe(true);
      
      // Verify agent is no longer in room
      const finalUsers = await roomsAdapter.listRoomUsers({ roomName: 'membership-test' });
      expect(finalUsers.agents).not.toContain('agent1');
    });
    
    it('should enforce room existence for operations', async () => {
      // Try to enter non-existent room
      await expect(roomsAdapter.enterRoom({
        agentName: 'agent1',
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
      
      // Try to list users of non-existent room
      await expect(roomsAdapter.listRoomUsers({
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
    });
  });
  
  describe('Messaging Adapter with Real Implementation', () => {
    beforeEach(async () => {
      // Set up room and agent for messaging tests
      await roomsAdapter.createRoom({ roomName: 'chat-room' });
      await roomsAdapter.enterRoom({ agentName: 'agent1', roomName: 'chat-room' });
    });
    
    it('should send and retrieve messages', async () => {
      // Send message
      const sendResult = await messagingAdapter.sendMessage({
        agentName: 'agent1',
        roomName: 'chat-room',
        message: 'Hello, world!'
      });
      
      expect(sendResult.success).toBe(true);
      expect(sendResult.messageId).toBeDefined();
      expect(sendResult.mentions).toEqual([]);
      
      // Retrieve messages
      const messages = await messagingAdapter.getMessages({
        agentName: 'agent1',
        roomName: 'chat-room'
      });
      
      expect(messages.messages).toHaveLength(1);
      expect(messages.messages[0].message).toBe('Hello, world!');
      expect(messages.messages[0].agentName).toBe('agent1');
    });
    
    it('should extract mentions correctly', async () => {
      const sendResult = await messagingAdapter.sendMessage({
        agentName: 'agent1',
        roomName: 'chat-room',
        message: 'Hey @agent2 and @agent3, check this out!'
      });
      
      expect(sendResult.mentions).toEqual(['agent2', 'agent3']);
      
      // Verify mentions are stored
      const messages = await messagingAdapter.getMessages({
        agentName: 'agent1',
        roomName: 'chat-room'
      });
      
      expect(messages.messages[0].mentions).toEqual(['agent2', 'agent3']);
    });
    
    it('should enforce room membership for messaging', async () => {
      // Try to send message from non-member
      await expect(messagingAdapter.sendMessage({
        agentName: 'agent2',
        roomName: 'chat-room',
        message: 'Should fail'
      })).rejects.toThrow(AgentNotInRoomError);
      
      // Try to get messages as non-member
      await expect(messagingAdapter.getMessages({
        agentName: 'agent2',
        roomName: 'chat-room'
      })).rejects.toThrow(AgentNotInRoomError);
    });
    
    it('should support message pagination', async () => {
      // Send multiple messages
      for (let i = 1; i <= 10; i++) {
        await messagingAdapter.sendMessage({
          agentName: 'agent1',
          roomName: 'chat-room',
          message: `Message ${i}`
        });
      }
      
      // Get first page
      const firstPage = await messagingAdapter.getMessages({
        agentName: 'agent1',
        roomName: 'chat-room',
        limit: 5
      });
      
      expect(firstPage.messages).toHaveLength(5);
      expect(firstPage.messages[0].message).toBe('Message 1');
      expect(firstPage.messages[4].message).toBe('Message 5');
      
      // Get second page
      const secondPage = await messagingAdapter.getMessages({
        agentName: 'agent1',
        roomName: 'chat-room',
        limit: 5,
        before: firstPage.messages[4].id
      });
      
      expect(secondPage.messages).toHaveLength(5);
      expect(secondPage.messages[0].message).toBe('Message 6');
    });
  });
  
  describe('Management Adapter with Real Implementation', () => {
    beforeEach(async () => {
      // Set up test data
      await roomsAdapter.createRoom({ roomName: 'stats-room-1' });
      await roomsAdapter.createRoom({ roomName: 'stats-room-2' });
      await roomsAdapter.enterRoom({ agentName: 'agent1', roomName: 'stats-room-1' });
      await roomsAdapter.enterRoom({ agentName: 'agent2', roomName: 'stats-room-1' });
      await roomsAdapter.enterRoom({ agentName: 'agent1', roomName: 'stats-room-2' });
    });
    
    it('should provide accurate system status', async () => {
      // Send some messages
      await messagingAdapter.sendMessage({
        agentName: 'agent1',
        roomName: 'stats-room-1',
        message: 'First message'
      });
      
      await messagingAdapter.sendMessage({
        agentName: 'agent2',
        roomName: 'stats-room-1',
        message: 'Second message'
      });
      
      const status = await managementAdapter.getStatus();
      
      expect(status.totalRooms).toBe(2);
      expect(status.totalMessages).toBeGreaterThanOrEqual(2);
      expect(status.activeAgents).toBeGreaterThanOrEqual(2);
      expect(status.serverVersion).toBe('1.0.0');
      expect(status.rooms).toHaveLength(2);
      
      const room1 = status.rooms.find(r => r.name === 'stats-room-1');
      expect(room1?.activeAgents).toBe(2);
    });
    
    it('should clear room messages', async () => {
      // Send messages
      await messagingAdapter.sendMessage({
        agentName: 'agent1',
        roomName: 'stats-room-1',
        message: 'Message 1'
      });
      
      await messagingAdapter.sendMessage({
        agentName: 'agent1',
        roomName: 'stats-room-1',
        message: 'Message 2'
      });
      
      // Verify messages exist
      const beforeClear = await messagingAdapter.getMessages({
        agentName: 'agent1',
        roomName: 'stats-room-1'
      });
      expect(beforeClear.messages).toHaveLength(2);
      
      // Clear messages
      const clearResult = await managementAdapter.clearRoomMessages({
        roomName: 'stats-room-1'
      });
      
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedMessages).toBe(2);
      
      // Verify messages are gone
      const afterClear = await messagingAdapter.getMessages({
        agentName: 'agent1',
        roomName: 'stats-room-1'
      });
      expect(afterClear.messages).toHaveLength(0);
    });
    
    it('should enforce room existence for management operations', async () => {
      await expect(managementAdapter.clearRoomMessages({
        roomName: 'non-existent'
      })).rejects.toThrow(RoomNotFoundError);
    });
  });
  
  describe('Cross-Adapter Integration', () => {
    it('should maintain consistency across all adapters', async () => {
      // Create room
      await roomsAdapter.createRoom({
        roomName: 'integration-room',
        description: 'Full integration test'
      });
      
      // Agents join
      await roomsAdapter.enterRoom({ agentName: 'alice', roomName: 'integration-room' });
      await roomsAdapter.enterRoom({ agentName: 'bob', roomName: 'integration-room' });
      
      // Send messages
      await messagingAdapter.sendMessage({
        agentName: 'alice',
        roomName: 'integration-room',
        message: 'Hello @bob!'
      });
      
      await messagingAdapter.sendMessage({
        agentName: 'bob',
        roomName: 'integration-room',
        message: 'Hi @alice, how are you?'
      });
      
      // Verify through rooms adapter
      const users = await roomsAdapter.listRoomUsers({ roomName: 'integration-room' });
      expect(users.agents).toContain('alice');
      expect(users.agents).toContain('bob');
      
      // Verify through messaging adapter
      const messages = await messagingAdapter.getMessages({
        agentName: 'alice',
        roomName: 'integration-room'
      });
      expect(messages.messages).toHaveLength(2);
      expect(messages.messages[0].mentions).toContain('bob');
      expect(messages.messages[1].mentions).toContain('alice');
      
      // Verify through management adapter
      const status = await managementAdapter.getStatus();
      expect(status.totalRooms).toBe(1);
      expect(status.totalMessages).toBe(2);
      expect(status.activeAgents).toBe(2);
      
      const room = status.rooms.find(r => r.name === 'integration-room');
      expect(room?.messageCount).toBe(2);
      expect(room?.activeAgents).toBe(2);
    });
    
    it('should handle complex workflow scenarios', async () => {
      // Multi-room scenario
      await roomsAdapter.createRoom({ roomName: 'general' });
      await roomsAdapter.createRoom({ roomName: 'dev-team' });
      
      // Agents with different room memberships
      await roomsAdapter.enterRoom({ agentName: 'alice', roomName: 'general' });
      await roomsAdapter.enterRoom({ agentName: 'alice', roomName: 'dev-team' });
      await roomsAdapter.enterRoom({ agentName: 'bob', roomName: 'general' });
      await roomsAdapter.enterRoom({ agentName: 'charlie', roomName: 'dev-team' });
      
      // Messages in different rooms
      await messagingAdapter.sendMessage({
        agentName: 'alice',
        roomName: 'general',
        message: 'General announcement'
      });
      
      await messagingAdapter.sendMessage({
        agentName: 'alice',
        roomName: 'dev-team',
        message: '@charlie ready for code review?'
      });
      
      await messagingAdapter.sendMessage({
        agentName: 'charlie',
        roomName: 'dev-team',
        message: '@alice yes, please review PR #123'
      });
      
      // Verify isolation
      const generalMessages = await messagingAdapter.getMessages({
        agentName: 'alice',
        roomName: 'general'
      });
      expect(generalMessages.messages).toHaveLength(1);
      
      const devMessages = await messagingAdapter.getMessages({
        agentName: 'alice',
        roomName: 'dev-team'
      });
      expect(devMessages.messages).toHaveLength(2);
      
      // Bob shouldn't see dev-team messages
      await expect(messagingAdapter.getMessages({
        agentName: 'bob',
        roomName: 'dev-team'
      })).rejects.toThrow(AgentNotInRoomError);
      
      // Final status check
      const finalStatus = await managementAdapter.getStatus();
      expect(finalStatus.totalRooms).toBe(2);
      expect(finalStatus.totalMessages).toBe(3);
      expect(finalStatus.activeAgents).toBe(3);
    });
  });
  
  describe('Error Handling in Real Implementation', () => {
    it('should maintain data consistency on errors', async () => {
      await roomsAdapter.createRoom({ roomName: 'error-test' });
      await roomsAdapter.enterRoom({ agentName: 'agent1', roomName: 'error-test' });
      
      // Send valid message
      await messagingAdapter.sendMessage({
        agentName: 'agent1',
        roomName: 'error-test',
        message: 'Valid message'
      });
      
      // Try invalid operation
      try {
        await messagingAdapter.sendMessage({
          agentName: 'agent2', // Not in room
          roomName: 'error-test',
          message: 'Should fail'
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AgentNotInRoomError);
      }
      
      // Verify original message still exists
      const messages = await messagingAdapter.getMessages({
        agentName: 'agent1',
        roomName: 'error-test'
      });
      expect(messages.messages).toHaveLength(1);
      expect(messages.messages[0].message).toBe('Valid message');
    });
  });
});