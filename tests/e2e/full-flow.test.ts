import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MemoryTransport } from '../helpers/MemoryTransport.js';
import { MockDataLayer } from '../helpers/MockDataLayer.js';
import { MockToolRegistry } from '../helpers/MockToolRegistry.js';

describe('Agent Communication MCP Server E2E Tests', () => {
  let server: Server;
  let transport: MemoryTransport;
  let dataLayer: MockDataLayer;
  let toolRegistry: MockToolRegistry;
  
  beforeAll(async () => {
    // Initialize MCP server with memory transport
    server = new Server({
      name: 'agent-communication',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {}  // Enable tool support
      }
    });
    
    transport = new MemoryTransport();
    dataLayer = new MockDataLayer();
    toolRegistry = new MockToolRegistry(dataLayer);
    
    // Connect server to transport
    await server.connect(transport);
    
    // Register all MCP tools
    await toolRegistry.registerAll(server);
  });
  
  afterAll(async () => {
    await transport.close();
  });
  
  beforeEach(() => {
    // Reset data layer for each test
    dataLayer.reset();
  });
  
  describe('Complete workflow scenarios', () => {
    it('should complete room creation → agent join → message flow', async () => {
      // 1. Create room
      const createRoomResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'test-room',
            description: 'E2E test room'
          }
        }
      });
      
      expect(createRoomResponse.error).toBeUndefined();
      expect(createRoomResponse.result).toBeDefined();
      
      const createResult = JSON.parse(createRoomResponse.result!.content[0].text);
      expect(createResult.success).toBe(true);
      expect(createResult.roomName).toBe('test-room');
      
      // 2. Agent enters room
      const enterRoomResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'agent1',
            roomName: 'test-room'
          }
        }
      });
      
      expect(enterRoomResponse.error).toBeUndefined();
      const enterResult = JSON.parse(enterRoomResponse.result!.content[0].text);
      expect(enterResult.success).toBe(true);
      
      // 3. Second agent enters room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'agent2',
            roomName: 'test-room'
          }
        }
      });
      
      // 4. Send message with mention
      const sendMessageResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'agent1',
            roomName: 'test-room',
            message: 'Hello @agent2, welcome to the room!'
          }
        }
      });
      
      expect(sendMessageResponse.error).toBeUndefined();
      const sendResult = JSON.parse(sendMessageResponse.result!.content[0].text);
      expect(sendResult.success).toBe(true);
      expect(sendResult.mentions).toContain('agent2');
      expect(sendResult.messageId).toMatch(/^msg_\d+_[a-z0-9]+$/);
      
      // 5. Agent2 responds
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'agent2',
            roomName: 'test-room',
            message: 'Thanks @agent1! Happy to be here.'
          }
        }
      });
      
      // 6. Retrieve messages
      const getMessagesResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'agent1',
            roomName: 'test-room'
          }
        }
      });
      
      expect(getMessagesResponse.error).toBeUndefined();
      const messagesResult = JSON.parse(getMessagesResponse.result!.content[0].text);
      expect(messagesResult.messages).toHaveLength(2);
      expect(messagesResult.messages[0].agentName).toBe('agent1');
      expect(messagesResult.messages[1].agentName).toBe('agent2');
      
      // 7. Check server status
      const statusResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_status',
          arguments: {}
        }
      });
      
      expect(statusResponse.error).toBeUndefined();
      const statusResult = JSON.parse(statusResponse.result!.content[0].text);
      expect(statusResult.totalRooms).toBe(1);
      expect(statusResult.totalMessages).toBe(2);
      expect(statusResult.activeAgents).toBe(2);
    });
    
    it('should handle multi-room conversation scenario', async () => {
      // Create multiple rooms
      const rooms = [
        { name: 'general', description: 'General discussion' },
        { name: 'dev-team', description: 'Development team' },
        { name: 'alerts', description: 'System alerts' }
      ];
      
      for (const room of rooms) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: room
          }
        });
      }
      
      // List all rooms
      const listRoomsResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_rooms',
          arguments: {}
        }
      });
      
      expect(listRoomsResponse.error).toBeUndefined();
      const roomsList = JSON.parse(listRoomsResponse.result!.content[0].text);
      expect(roomsList.rooms).toHaveLength(3);
      expect(roomsList.rooms.map((r: any) => r.name)).toContain('general');
      expect(roomsList.rooms.map((r: any) => r.name)).toContain('dev-team');
      expect(roomsList.rooms.map((r: any) => r.name)).toContain('alerts');
      
      // Agents join different room combinations
      const agentRoomCombinations = [
        { agent: 'alice', rooms: ['general', 'dev-team'] },
        { agent: 'bob', rooms: ['general', 'dev-team'] },
        { agent: 'charlie', rooms: ['dev-team'] },
        { agent: 'system', rooms: ['alerts'] }
      ];
      
      for (const combo of agentRoomCombinations) {
        for (const roomName of combo.rooms) {
          await transport.simulateRequest({
            jsonrpc: '2.0',
            id: Math.random(),
            method: 'tools/call',
            params: {
              name: 'agent_communication_enter_room',
              arguments: {
                agentName: combo.agent,
                roomName
              }
            }
          });
        }
      }
      
      // Send messages to different rooms
      const messages = [
        { agent: 'alice', room: 'general', message: 'Good morning everyone!' },
        { agent: 'bob', room: 'general', message: 'Morning @alice! Ready for the day.' },
        { agent: 'alice', room: 'dev-team', message: '@bob @charlie standup in 10 minutes' },
        { agent: 'charlie', room: 'dev-team', message: '@alice confirmed, I will be there' },
        { agent: 'system', room: 'alerts', message: 'Server load is normal' }
      ];
      
      for (const msg of messages) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: msg.agent,
              roomName: msg.room,
              message: msg.message
            }
          }
        });
      }
      
      // Verify message isolation between rooms
      const generalMessages = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'alice',
            roomName: 'general'
          }
        }
      });
      
      const generalResult = JSON.parse(generalMessages.result!.content[0].text);
      expect(generalResult.messages).toHaveLength(2);
      expect(generalResult.messages.every((m: any) => m.roomName === 'general')).toBe(true);
      
      // Check final system status
      const finalStatus = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_status',
          arguments: {}
        }
      });
      
      const finalStatusResult = JSON.parse(finalStatus.result!.content[0].text);
      expect(finalStatusResult.totalRooms).toBe(3);
      expect(finalStatusResult.totalMessages).toBe(5);
      expect(finalStatusResult.activeAgents).toBe(4);
    });
    
    it('should handle agent lifecycle and permissions', async () => {
      // Create room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'lifecycle-test',
            description: 'Testing agent lifecycle'
          }
        }
      });
      
      // Agent1 joins and sends message
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'agent1',
            roomName: 'lifecycle-test'
          }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'agent1',
            roomName: 'lifecycle-test',
            message: 'I am in the room'
          }
        }
      });
      
      // Try to send message from non-member agent (should fail)
      const unauthorizedMessage = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'agent2',
            roomName: 'lifecycle-test',
            message: 'Can I send this?'
          }
        }
      });
      
      expect(unauthorizedMessage.error).toBeDefined();
      expect(unauthorizedMessage.error!.code).toBe(403);
      expect(unauthorizedMessage.error!.message).toContain('not in room');
      
      // Agent2 joins room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'agent2',
            roomName: 'lifecycle-test'
          }
        }
      });
      
      // Now agent2 can send messages
      const authorizedMessage = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'agent2',
            roomName: 'lifecycle-test',
            message: 'Now I can send messages!'
          }
        }
      });
      
      expect(authorizedMessage.error).toBeUndefined();
      
      // List room users
      const listUsersResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_room_users',
          arguments: {
            roomName: 'lifecycle-test'
          }
        }
      });
      
      const usersResult = JSON.parse(listUsersResponse.result!.content[0].text);
      expect(usersResult.agents).toHaveLength(2);
      expect(usersResult.agents).toContain('agent1');
      expect(usersResult.agents).toContain('agent2');
      
      // Agent1 leaves room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'agent_communication_leave_room',
          arguments: {
            agentName: 'agent1',
            roomName: 'lifecycle-test'
          }
        }
      });
      
      // Agent1 can no longer send messages
      const postLeaveMessage = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'agent1',
            roomName: 'lifecycle-test',
            message: 'Can I still send?'
          }
        }
      });
      
      expect(postLeaveMessage.error).toBeDefined();
      expect(postLeaveMessage.error!.code).toBe(403);
      expect(postLeaveMessage.error!.message).toContain('not in room');
      
      // Verify only agent2 remains
      const finalUsersResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_room_users',
          arguments: {
            roomName: 'lifecycle-test'
          }
        }
      });
      
      const finalUsersResult = JSON.parse(finalUsersResponse.result!.content[0].text);
      expect(finalUsersResult.agents).toEqual(['agent2']);
    });
    
    it('should handle message management operations', async () => {
      // Setup room with messages
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'cleanup-test',
            description: 'Testing message cleanup'
          }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'agent1',
            roomName: 'cleanup-test'
          }
        }
      });
      
      // Send multiple messages
      for (let i = 1; i <= 5; i++) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 10,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'agent1',
              roomName: 'cleanup-test',
              message: `Test message ${i}`
            }
          }
        });
      }
      
      // Verify messages exist
      const preCleanupMessages = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'agent1',
            roomName: 'cleanup-test'
          }
        }
      });
      
      const preCleanupResult = JSON.parse(preCleanupMessages.result!.content[0].text);
      expect(preCleanupResult.messages).toHaveLength(5);
      
      // Clear room messages
      const clearResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'agent_communication_clear_room_messages',
          arguments: {
            roomName: 'cleanup-test'
          }
        }
      });
      
      expect(clearResponse.error).toBeUndefined();
      const clearResult = JSON.parse(clearResponse.result!.content[0].text);
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedCount).toBe(5);
      
      // Verify messages are cleared
      const postCleanupMessages = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'agent1',
            roomName: 'cleanup-test'
          }
        }
      });
      
      const postCleanupResult = JSON.parse(postCleanupMessages.result!.content[0].text);
      expect(postCleanupResult.messages).toHaveLength(0);
      
      // Verify room and agent presence are preserved
      const usersResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_room_users',
          arguments: {
            roomName: 'cleanup-test'
          }
        }
      });
      
      const usersResult = JSON.parse(usersResponse.result!.content[0].text);
      expect(usersResult.agents).toContain('agent1');
    });
  });
  
  describe('Error scenarios and edge cases', () => {
    it('should handle non-existent room operations', async () => {
      // Try to enter non-existent room
      const enterResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'agent1',
            roomName: 'non-existent'
          }
        }
      });
      
      expect(enterResponse.error).toBeDefined();
      expect(enterResponse.error!.code).toBe(404);
      expect(enterResponse.error!.message).toContain('not found');
      
      // Try to send message to non-existent room
      const messageResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'agent1',
            roomName: 'non-existent',
            message: 'This should fail'
          }
        }
      });
      
      expect(messageResponse.error).toBeDefined();
      expect(messageResponse.error!.code).toBe(404);
      expect(messageResponse.error!.message).toContain('not found');
      
      // Try to list users in non-existent room
      const usersResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_room_users',
          arguments: {
            roomName: 'non-existent'
          }
        }
      });
      
      expect(usersResponse.error).toBeDefined();
      expect(usersResponse.error!.code).toBe(404);
      expect(usersResponse.error!.message).toContain('not found');
    });
    
    it('should handle duplicate room creation', async () => {
      // Create room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'duplicate-test',
            description: 'First creation'
          }
        }
      });
      
      // Try to create same room again
      const duplicateResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'duplicate-test',
            description: 'Second creation attempt'
          }
        }
      });
      
      expect(duplicateResponse.error).toBeDefined();
      expect(duplicateResponse.error!.code).toBe(409);
      expect(duplicateResponse.error!.message).toContain('already exists');
    });
    
    it('should handle message pagination correctly', async () => {
      // Setup room and agent
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'pagination-test'
          }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'agent1',
            roomName: 'pagination-test'
          }
        }
      });
      
      // Send 15 messages with proper numbering
      const messageIds = [];
      for (let i = 1; i <= 15; i++) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 10,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'agent1',
              roomName: 'pagination-test',
              message: `Message ${i.toString().padStart(2, '0')}` // Use zero-padding for proper sorting
            }
          }
        });
        const result = JSON.parse(response.result!.content[0].text);
        messageIds.push(result.messageId);
        // Small delay to ensure ordering
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Get first page (limit 5)
      const page1Response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'agent1',
            roomName: 'pagination-test',
            limit: 5
          }
        }
      });
      
      const page1Result = JSON.parse(page1Response.result!.content[0].text);
      expect(page1Result.messages).toHaveLength(5);
      // Messages are returned oldest first in this test environment
      expect(page1Result.messages[0].message).toBe('Message 01');
      expect(page1Result.messages[4].message).toBe('Message 05');
      
      // Get second page using offset
      const page2Response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'agent1',
            roomName: 'pagination-test',
            limit: 5,
            offset: 5
          }
        }
      });
      
      const page2Result = JSON.parse(page2Response.result!.content[0].text);
      expect(page2Result.messages).toHaveLength(5);
      // With offset 5 and oldest first, should get messages 6-10
      expect(page2Result.messages[0].message).toBe('Message 06');
      expect(page2Result.messages[4].message).toBe('Message 10');
    });
  });
  
  describe('Performance and concurrency', () => {
    it('should handle multiple concurrent requests', async () => {
      // Create room first
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'concurrent-test'
          }
        }
      });
      
      // Concurrent agent joins
      const joinPromises = ['agent1', 'agent2', 'agent3', 'agent4', 'agent5'].map((agent, index) =>
        transport.simulateRequest({
          jsonrpc: '2.0',
          id: index + 10,
          method: 'tools/call',
          params: {
            name: 'agent_communication_enter_room',
            arguments: {
              agentName: agent,
              roomName: 'concurrent-test'
            }
          }
        })
      );
      
      const joinResults = await Promise.all(joinPromises);
      joinResults.forEach(result => {
        expect(result.error).toBeUndefined();
      });
      
      // Concurrent message sending
      const messagePromises = ['agent1', 'agent2', 'agent3'].map((agent, index) =>
        transport.simulateRequest({
          jsonrpc: '2.0',
          id: index + 20,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: agent,
              roomName: 'concurrent-test',
              message: `Concurrent message from ${agent}`
            }
          }
        })
      );
      
      const messageResults = await Promise.all(messagePromises);
      messageResults.forEach(result => {
        expect(result.error).toBeUndefined();
      });
      
      // Verify final state
      const usersResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_room_users',
          arguments: {
            roomName: 'concurrent-test'
          }
        }
      });
      
      const usersResult = JSON.parse(usersResponse.result!.content[0].text);
      expect(usersResult.agents).toHaveLength(5);
      
      const messagesResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'agent1',
            roomName: 'concurrent-test'
          }
        }
      });
      
      const messagesResult = JSON.parse(messagesResponse.result!.content[0].text);
      expect(messagesResult.messages).toHaveLength(3);
    });
  });
});