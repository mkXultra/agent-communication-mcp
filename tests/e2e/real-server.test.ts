import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MemoryTransport } from '../helpers/MemoryTransport.js';
import { ToolRegistry } from '../../src/server/ToolRegistry.js';
import path from 'path';
import { promises as fs } from 'fs';

describe('Real MCP Server E2E Tests', () => {
  let server: Server;
  let transport: MemoryTransport;
  let toolRegistry: ToolRegistry;
  let testDataDir: string;
  
  beforeAll(async () => {
    // Create temporary test directory
    testDataDir = path.join(process.cwd(), 'e2e-test-' + Date.now());
    await fs.mkdir(testDataDir, { recursive: true });
    
    // Initialize real MCP server
    server = new Server({
      name: 'agent-communication',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {}  // Enable tool support
      }
    });
    
    transport = new MemoryTransport();
    toolRegistry = new ToolRegistry(testDataDir);
    
    // Connect server to transport
    await server.connect(transport);
    
    // Register all real tools
    await toolRegistry.registerAll(server);
  });
  
  afterAll(async () => {
    await transport.close();
    await toolRegistry.shutdown();
    
    // Clean up test directory
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });
  
  beforeEach(async () => {
    // Clean data directory between tests
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(
        files.map(file => fs.rm(path.join(testDataDir, file), { recursive: true, force: true }))
      );
    } catch (error) {
      // Ignore if directory doesn't exist
    }
  });
  
  describe('Real Server Tool Discovery', () => {
    it('should list all 9 tools correctly', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      
      const tools = response.result!.tools;
      expect(tools).toHaveLength(9);
      
      const expectedTools = [
        'agent_communication_list_rooms',
        'agent_communication_create_room',
        'agent_communication_enter_room',
        'agent_communication_leave_room',
        'agent_communication_list_room_users',
        'agent_communication_send_message',
        'agent_communication_get_messages',
        'agent_communication_get_status',
        'agent_communication_clear_room_messages'
      ];
      
      const toolNames = tools.map((tool: any) => tool.name);
      expectedTools.forEach(expectedTool => {
        expect(toolNames).toContain(expectedTool);
      });
    });
  });
  
  describe('Real Server Complete Workflow', () => {
    it('should handle full room creation and messaging workflow', async () => {
      // 1. Create room
      const createResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'real-test-room',
            description: 'A real test room'
          }
        }
      });
      
      expect(createResponse.error).toBeUndefined();
      const createResult = JSON.parse(createResponse.result!.content[0].text);
      expect(createResult.success).toBe(true);
      expect(createResult.roomName).toBe('real-test-room');
      
      // 2. Verify room appears in list
      const listResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_rooms',
          arguments: {}
        }
      });
      
      expect(listResponse.error).toBeUndefined();
      const listResult = JSON.parse(listResponse.result!.content[0].text);
      expect(listResult.rooms).toHaveLength(1);
      expect(listResult.rooms[0].name).toBe('real-test-room');
      expect(listResult.rooms[0].description).toBe('A real test room');
      
      // 3. Agent enters room
      const enterResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'real-agent-1',
            roomName: 'real-test-room'
          }
        }
      });
      
      expect(enterResponse.error).toBeUndefined();
      const enterResult = JSON.parse(enterResponse.result!.content[0].text);
      expect(enterResult.success).toBe(true);
      
      // 4. Verify agent is in room
      const usersResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_room_users',
          arguments: {
            roomName: 'real-test-room'
          }
        }
      });
      
      expect(usersResponse.error).toBeUndefined();
      const usersResult = JSON.parse(usersResponse.result!.content[0].text);
      expect(usersResult.agents).toContain('real-agent-1');
      
      // 5. Send message
      const messageResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'real-agent-1',
            roomName: 'real-test-room',
            message: 'Hello from real implementation!'
          }
        }
      });
      
      expect(messageResponse.error).toBeUndefined();
      const messageResult = JSON.parse(messageResponse.result!.content[0].text);
      expect(messageResult.success).toBe(true);
      expect(messageResult.messageId).toBeDefined();
      
      // 6. Retrieve messages
      const getMessagesResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'real-agent-1',
            roomName: 'real-test-room'
          }
        }
      });
      
      expect(getMessagesResponse.error).toBeUndefined();
      const messagesResult = JSON.parse(getMessagesResponse.result!.content[0].text);
      expect(messagesResult.messages).toHaveLength(1);
      expect(messagesResult.messages[0].message).toBe('Hello from real implementation!');
      expect(messagesResult.messages[0].agentName).toBe('real-agent-1');
      
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
      expect(statusResult.totalMessages).toBeGreaterThanOrEqual(1);
      expect(statusResult.activeAgents).toBeGreaterThanOrEqual(1);
      expect(statusResult.serverVersion).toBe('1.0.0');
    });
    
    it('should handle file persistence across operations', async () => {
      // Create room and send message
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'persistent-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'persistent-agent', roomName: 'persistent-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'persistent-agent',
            roomName: 'persistent-room',
            message: 'Persistent message'
          }
        }
      });
      
      // Verify files were created
      const roomsFile = path.join(testDataDir, 'rooms.json');
      const presenceFile = path.join(testDataDir, 'rooms', 'persistent-room', 'presence.json');
      const messagesFile = path.join(testDataDir, 'rooms', 'persistent-room', 'messages.jsonl');
      
      expect(await fs.access(roomsFile).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(presenceFile).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(messagesFile).then(() => true).catch(() => false)).toBe(true);
      
      // Check file contents
      const roomsContent = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
      expect(roomsContent.rooms).toHaveLength(1);
      expect(roomsContent.rooms[0].name).toBe('persistent-room');
      
      const messagesContent = await fs.readFile(messagesFile, 'utf8');
      const messageLines = messagesContent.trim().split('\n');
      expect(messageLines).toHaveLength(1);
      const message = JSON.parse(messageLines[0]);
      expect(message.message).toBe('Persistent message');
      expect(message.agentName).toBe('persistent-agent');
    });
  });
  
  describe('Real Server Error Handling', () => {
    it('should handle room not found errors correctly', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'test-agent',
            roomName: 'non-existent-room'
          }
        }
      });
      
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(404);
      expect(response.error!.code).toBe(404);
      expect(response.error!.message).toContain('not found');
      expect(response.error!.message).toContain('non-existent-room');
    });
    
    it('should handle agent not in room errors', async () => {
      // Create room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'restricted-room' }
        }
      });
      
      // Try to send message without joining
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'unauthorized-agent',
            roomName: 'restricted-room',
            message: 'Should fail'
          }
        }
      });
      
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(403);
      expect(response.error!.code).toBe(403);
      expect(response.error!.message).toContain('not in room');
    });
    
    it('should handle duplicate room creation', async () => {
      // Create room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'duplicate-room' }
        }
      });
      
      // Try to create same room again
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'duplicate-room' }
        }
      });
      
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(409);
      expect(response.error!.code).toBe(409);
      expect(response.error!.message).toContain('already exists');
    });
  });
  
  describe('Real Server Concurrency', () => {
    it('should handle concurrent operations safely', async () => {
      // Create room first
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'concurrent-room' }
        }
      });
      
      // Multiple agents join concurrently
      const joinPromises = [];
      for (let i = 1; i <= 5; i++) {
        joinPromises.push(
          transport.simulateRequest({
            jsonrpc: '2.0',
            id: i + 10,
            method: 'tools/call',
            params: {
              name: 'agent_communication_enter_room',
              arguments: {
                agentName: `concurrent-agent-${i}`,
                roomName: 'concurrent-room'
              }
            }
          })
        );
      }
      
      const joinResults = await Promise.all(joinPromises);
      joinResults.forEach(result => {
        expect(result.error).toBeUndefined();
      });
      
      // Send messages concurrently
      const messagePromises = [];
      for (let i = 1; i <= 3; i++) {
        messagePromises.push(
          transport.simulateRequest({
            jsonrpc: '2.0',
            id: i + 20,
            method: 'tools/call',
            params: {
              name: 'agent_communication_send_message',
              arguments: {
                agentName: `concurrent-agent-${i}`,
                roomName: 'concurrent-room',
                message: `Concurrent message ${i}`
              }
            }
          })
        );
      }
      
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
          arguments: { roomName: 'concurrent-room' }
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
            agentName: 'concurrent-agent-1',
            roomName: 'concurrent-room'
          }
        }
      });
      
      const messagesResult = JSON.parse(messagesResponse.result!.content[0].text);
      expect(messagesResult.messages).toHaveLength(3);
    });
  });
  
  describe('Real Server Management Operations', () => {
    it('should provide accurate real-time statistics', async () => {
      // Create multiple rooms and activity
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'stats-room-1' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'stats-room-2' }
        }
      });
      
      // Add agents and messages
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'stats-agent-1', roomName: 'stats-room-1' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'stats-agent-1',
            roomName: 'stats-room-1',
            message: 'Stats test message'
          }
        }
      });
      
      const statusResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_status',
          arguments: {}
        }
      });
      
      expect(statusResponse.error).toBeUndefined();
      const statusResult = JSON.parse(statusResponse.result!.content[0].text);
      
      expect(statusResult.totalRooms).toBe(2);
      expect(statusResult.totalMessages).toBeGreaterThanOrEqual(1);
      expect(statusResult.activeAgents).toBeGreaterThanOrEqual(1);
      expect(statusResult.rooms).toHaveLength(2);
    });
    
    it('should clear room messages effectively', async () => {
      // Setup room with messages
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'clear-test-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'clear-agent', roomName: 'clear-test-room' }
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
              agentName: 'clear-agent',
              roomName: 'clear-test-room',
              message: `Message ${i}`
            }
          }
        });
      }
      
      // Verify messages exist
      const beforeClear = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'clear-agent',
            roomName: 'clear-test-room'
          }
        }
      });
      
      const beforeResult = JSON.parse(beforeClear.result!.content[0].text);
      expect(beforeResult.messages).toHaveLength(5);
      
      // Clear messages
      const clearResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'agent_communication_clear_room_messages',
          arguments: { roomName: 'clear-test-room', confirm: true }
        }
      });
      
      expect(clearResponse.error).toBeUndefined();
      const clearResult = JSON.parse(clearResponse.result!.content[0].text);
      expect(clearResult.success).toBe(true);
      expect(clearResult.clearedMessages).toBe(5);
      
      // Verify messages are gone
      const afterClear = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'clear-agent',
            roomName: 'clear-test-room'
          }
        }
      });
      
      const afterResult = JSON.parse(afterClear.result!.content[0].text);
      expect(afterResult.messages).toHaveLength(0);
    });
  });
});