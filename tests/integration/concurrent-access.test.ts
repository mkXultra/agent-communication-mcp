import { describe, it, expect, beforeEach } from 'vitest';
import { LockService } from '../../src/services/LockService';
import { MessagingAdapter } from '../../src/adapters/MessagingAdapter';
import { RoomsAdapter } from '../../src/adapters/RoomsAdapter';
import './setup';

describe('Integration: Concurrent Access Test', () => {
  let lockService: LockService;
  let messagingAdapter: MessagingAdapter;
  let roomsAdapter: RoomsAdapter;

  beforeEach(async () => {
    // Use the unique test data directory from setup.ts
    const fs = await import('fs/promises');
    const path = await import('path');
    const actualDataDir = process.env.AGENT_COMM_DATA_DIR!;
    await fs.mkdir(actualDataDir, { recursive: true });
    await fs.mkdir(path.join(actualDataDir, 'rooms'), { recursive: true });
    
    lockService = new LockService();
    messagingAdapter = new MessagingAdapter(lockService);
    roomsAdapter = new RoomsAdapter(lockService);

    messagingAdapter.setRoomsAdapter(roomsAdapter);

    await Promise.all([
      messagingAdapter.initialize(),
      roomsAdapter.initialize()
    ]);
  });

  describe('Concurrent Message Sending', () => {
    const roomName = 'concurrent-test-room';
    const agentCount = 5;
    const messagesPerAgent = 10;

    it('should handle concurrent messages from multiple agents', async () => {
      // Create room and ensure directory structure
      await roomsAdapter.createRoom({ roomName });
      
      // Ensure room directory exists
      const fs = await import('fs/promises');
      const path = await import('path');
      const actualDataDir = process.env.AGENT_COMM_DATA_DIR!;
      const roomDir = path.join(actualDataDir, 'rooms', roomName);
      await fs.mkdir(roomDir, { recursive: true });

      // Create agents and have them join
      const agents = Array.from({ length: agentCount }, (_, i) => `agent-${i}`);
      await Promise.all(
        agents.map(agentName => roomsAdapter.enterRoom({ agentName, roomName }))
      );

      // Send messages concurrently
      const sendPromises: Promise<any>[] = [];
      for (let i = 0; i < agentCount; i++) {
        for (let j = 0; j < messagesPerAgent; j++) {
          sendPromises.push(
            messagingAdapter.sendMessage({
              agentName: agents[i],
              roomName,
              message: `Message ${j} from ${agents[i]}`
            })
          );
        }
      }

      // Wait for all messages to be sent
      const results = await Promise.all(sendPromises);
      
      // Verify all messages were sent successfully
      expect(results).toHaveLength(agentCount * messagesPerAgent);
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
      });

      // Verify message count
      const messages = await messagingAdapter.getMessages({
        roomName,
        limit: 100
      });
      expect(messages.messages).toHaveLength(agentCount * messagesPerAgent);
      expect(messages.count).toBe(agentCount * messagesPerAgent);
    });
  });

  describe('Concurrent Room Operations', () => {
    it('should handle concurrent room creation attempts', async () => {
      const roomPrefix = 'concurrent-room';
      const roomCount = 10;

      // Try to create multiple rooms concurrently
      const createPromises = Array.from({ length: roomCount }, (_, i) =>
        roomsAdapter.createRoom({
          roomName: `${roomPrefix}-${i}`,
          description: `Concurrent test room ${i}`
        })
      );

      const results = await Promise.allSettled(createPromises);
      
      // All should succeed since they have different names
      results.forEach((result, i) => {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value.success).toBe(true);
          expect(result.value.roomName).toBe(`${roomPrefix}-${i}`);
        }
      });

      // Verify all rooms were created
      const roomsList = await roomsAdapter.listRooms();
      expect(roomsList.rooms).toHaveLength(roomCount);
    });

    it('should handle concurrent join/leave operations', async () => {
      const roomName = 'join-leave-test';
      const agentCount = 20;

      // Create room
      await roomsAdapter.createRoom({ roomName });

      // Create agents
      const agents = Array.from({ length: agentCount }, (_, i) => `agent-${i}`);

      // Concurrent joins
      const joinPromises = agents.map(agentName =>
        roomsAdapter.enterRoom({ agentName, roomName })
      );
      const joinResults = await Promise.all(joinPromises);
      
      joinResults.forEach(result => {
        expect(result.success).toBe(true);
      });

      // Verify all agents joined
      const users1 = await roomsAdapter.listRoomUsers({ roomName });
      expect(users1.users).toHaveLength(agentCount);

      // Concurrent leaves (half the agents)
      const leavingAgents = agents.slice(0, agentCount / 2);
      const leavePromises = leavingAgents.map(agentName =>
        roomsAdapter.leaveRoom({ agentName, roomName })
      );
      const leaveResults = await Promise.all(leavePromises);
      
      leaveResults.forEach(result => {
        expect(result.success).toBe(true);
      });

      // Verify correct number of agents remain (users includes offline)
      const users2 = await roomsAdapter.listRoomUsers({ roomName });
      expect(users2.users).toHaveLength(agentCount); // All agents still in list
      
      // Check that half are offline
      const onlineUsers = users2.users.filter(u => u.status === 'online');
      expect(onlineUsers).toHaveLength(10); // Half of 20 agents should be online
    });
  });

  describe('File Lock Contention', () => {
    it('should serialize access when multiple operations target same file', async () => {
      const roomName = 'lock-test-room';
      const iterations = 10;

      await roomsAdapter.createRoom({ roomName });
      await roomsAdapter.enterRoom({ agentName: 'test-agent', roomName });

      // Track operation order
      const operationLog: string[] = [];
      const startTime = Date.now();

      // Create concurrent operations that would conflict
      const operations = Array.from({ length: iterations }, (_, i) => {
        return (async () => {
          const opStart = Date.now();
          
          // Send message (writes to messages.jsonl)
          await messagingAdapter.sendMessage({
            agentName: 'test-agent',
            roomName,
            message: `Message ${i}`
          });
          
          const opEnd = Date.now();
          operationLog.push(`Op ${i}: ${opEnd - opStart}ms`);
        })();
      });

      await Promise.all(operations);
      const totalTime = Date.now() - startTime;

      // Verify all messages were written
      const messages = await messagingAdapter.getMessages({ roomName, limit: iterations });
      expect(messages.messages).toHaveLength(iterations);

      // Log timing for analysis
      console.log('Lock contention test results:');
      console.log(`Total time: ${totalTime}ms`);
      console.log(`Average per operation: ${totalTime / iterations}ms`);
    });
  });
});