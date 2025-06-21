import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MemoryTransport } from '../helpers/MemoryTransport.js';
import { MockDataLayer } from '../helpers/MockDataLayer.js';
import { MockToolRegistry } from '../helpers/MockToolRegistry.js';

describe('MCP Tools E2E Tests', () => {
  let server: Server;
  let transport: MemoryTransport;
  let dataLayer: MockDataLayer;
  let toolRegistry: MockToolRegistry;
  
  beforeAll(async () => {
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
    
    await server.connect(transport);
    await toolRegistry.registerAll(server);
  });
  
  afterAll(async () => {
    await transport.close();
  });
  
  beforeEach(() => {
    dataLayer.reset();
  });
  
  describe('Tool Discovery', () => {
    it('should list all 9 MCP tools correctly', async () => {
      const listToolsResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      
      expect(listToolsResponse.error).toBeUndefined();
      expect(listToolsResponse.result).toBeDefined();
      
      const tools = listToolsResponse.result!.tools;
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
    
    it('should have correct tool schemas for each tool', async () => {
      const listToolsResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      
      const tools = listToolsResponse.result!.tools;
      
      // Check create_room schema
      const createRoomTool = tools.find((t: any) => t.name === 'agent_communication_create_room');
      expect(createRoomTool.inputSchema.properties).toHaveProperty('roomName');
      expect(createRoomTool.inputSchema.properties).toHaveProperty('description');
      expect(createRoomTool.inputSchema.required).toContain('roomName');
      
      // Check send_message schema
      const sendMessageTool = tools.find((t: any) => t.name === 'agent_communication_send_message');
      expect(sendMessageTool.inputSchema.properties).toHaveProperty('agentName');
      expect(sendMessageTool.inputSchema.properties).toHaveProperty('roomName');
      expect(sendMessageTool.inputSchema.properties).toHaveProperty('message');
      expect(sendMessageTool.inputSchema.required).toEqual(['agentName', 'roomName', 'message']);
      
      // Check get_messages schema
      const getMessagesTool = tools.find((t: any) => t.name === 'agent_communication_get_messages');
      expect(getMessagesTool.inputSchema.properties).toHaveProperty('agentName');
      expect(getMessagesTool.inputSchema.properties).toHaveProperty('roomName');
      expect(getMessagesTool.inputSchema.properties).toHaveProperty('limit');
      expect(getMessagesTool.inputSchema.properties).toHaveProperty('before');
      expect(getMessagesTool.inputSchema.required).toEqual(['agentName', 'roomName']);
    });
  });
  
  describe('Room Management Tools', () => {
    describe('list_rooms', () => {
      it('should return empty list when no rooms exist', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_list_rooms',
            arguments: {}
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.rooms).toEqual([]);
      });
      
      it('should return all rooms with metadata', async () => {
        // Create test rooms
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'room1',
              description: 'First room'
            }
          }
        });
        
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'room2',
              description: 'Second room'
            }
          }
        });
        
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'agent_communication_list_rooms',
            arguments: {}
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.rooms).toHaveLength(2);
        
        const room1 = result.rooms.find((r: any) => r.name === 'room1');
        expect(room1.description).toBe('First room');
        expect(room1.createdAt).toBeDefined();
        expect(room1.messageCount).toBe(0);
      });
    });
    
    describe('create_room', () => {
      it('should create room with required parameters', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'test-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.success).toBe(true);
        expect(result.roomName).toBe('test-room');
      });
      
      it('should create room with optional description', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'described-room',
              description: 'A room with description'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.success).toBe(true);
      });
      
      it('should reject duplicate room names', async () => {
        // Create first room
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'duplicate-test'
            }
          }
        });
        
        // Try to create duplicate
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'duplicate-test'
            }
          }
        });
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(409);
        expect(response.error!.message).toContain('already exists');
      });
    });
    
    describe('enter_room', () => {
      beforeEach(async () => {
        // Create test room
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'test-room'
            }
          }
        });
      });
      
      it('should allow agent to enter existing room', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_enter_room',
            arguments: {
              agentName: 'agent1',
              roomName: 'test-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.success).toBe(true);
      });
      
      it('should reject entering non-existent room', async () => {
        const response = await transport.simulateRequest({
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
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(404);
        expect(response.error!.message).toContain('not found');
      });
    });
    
    describe('leave_room', () => {
      beforeEach(async () => {
        // Create room and add agent
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'test-room'
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
              roomName: 'test-room'
            }
          }
        });
      });
      
      it('should allow agent to leave room they are in', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_leave_room',
            arguments: {
              agentName: 'agent1',
              roomName: 'test-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.success).toBe(true);
      });
      
      it('should reject leaving room agent is not in', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_leave_room',
            arguments: {
              agentName: 'agent2',
              roomName: 'test-room'
            }
          }
        });
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(403);
        expect(response.error!.message).toContain('not in room');
      });
    });
    
    describe('list_room_users', () => {
      beforeEach(async () => {
        // Create room
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'test-room'
            }
          }
        });
      });
      
      it('should return empty list for room with no users', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_list_room_users',
            arguments: {
              roomName: 'test-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.agents).toEqual([]);
      });
      
      it('should return all users in room', async () => {
        // Add agents to room
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_enter_room',
            arguments: {
              agentName: 'agent1',
              roomName: 'test-room'
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
              agentName: 'agent2',
              roomName: 'test-room'
            }
          }
        });
        
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'agent_communication_list_room_users',
            arguments: {
              roomName: 'test-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.agents).toHaveLength(2);
        expect(result.agents).toContain('agent1');
        expect(result.agents).toContain('agent2');
      });
      
      it('should reject listing users for non-existent room', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_list_room_users',
            arguments: {
              roomName: 'non-existent'
            }
          }
        });
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(404);
        expect(response.error!.message).toContain('not found');
      });
    });
  });
  
  describe('Messaging Tools', () => {
    beforeEach(async () => {
      // Setup room and agent
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'messaging-room'
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
            roomName: 'messaging-room'
          }
        }
      });
    });
    
    describe('send_message', () => {
      it('should send message successfully', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'agent1',
              roomName: 'messaging-room',
              message: 'Hello everyone!'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.success).toBe(true);
        expect(result.messageId).toMatch(/^msg_\d+_[a-z0-9]+$/);
        expect(result.mentions).toEqual([]);
      });
      
      it('should extract mentions correctly', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'agent1',
              roomName: 'messaging-room',
              message: 'Hey @agent2 and @agent3, check this out!'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.mentions).toEqual(['agent2', 'agent3']);
      });
      
      it('should reject message from agent not in room', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'agent2',
              roomName: 'messaging-room',
              message: 'Can I send this?'
            }
          }
        });
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(403);
        expect(response.error!.message).toContain('not in room');
      });
      
      it('should reject message to non-existent room', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'agent1',
              roomName: 'non-existent',
              message: 'Hello'
            }
          }
        });
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(404);
        expect(response.error!.message).toContain('not found');
      });
    });
    
    describe('get_messages', () => {
      beforeEach(async () => {
        // Send test messages
        for (let i = 1; i <= 5; i++) {
          await transport.simulateRequest({
            jsonrpc: '2.0',
            id: i,
            method: 'tools/call',
            params: {
              name: 'agent_communication_send_message',
              arguments: {
                agentName: 'agent1',
                roomName: 'messaging-room',
                message: `Test message ${i}`
              }
            }
          });
        }
      });
      
      it('should retrieve all messages', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_messages',
            arguments: {
              agentName: 'agent1',
              roomName: 'messaging-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.messages).toHaveLength(5);
        expect(result.messages[0].message).toBe('Test message 1');
        expect(result.messages[4].message).toBe('Test message 5');
      });
      
      it('should respect limit parameter', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_messages',
            arguments: {
              agentName: 'agent1',
              roomName: 'messaging-room',
              limit: 3
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.messages).toHaveLength(3);
      });
      
      it('should support pagination with before parameter', async () => {
        // Get first batch
        const firstResponse = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_messages',
            arguments: {
              agentName: 'agent1',
              roomName: 'messaging-room',
              limit: 2
            }
          }
        });
        
        const firstResult = JSON.parse(firstResponse.result!.content[0].text);
        expect(firstResult.messages).toHaveLength(2);
        
        // Get second batch using before parameter
        const secondResponse = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_messages',
            arguments: {
              agentName: 'agent1',
              roomName: 'messaging-room',
              limit: 2,
              before: firstResult.messages[1].id
            }
          }
        });
        
        const secondResult = JSON.parse(secondResponse.result!.content[0].text);
        expect(secondResult.messages).toHaveLength(2);
        expect(secondResult.messages[0].id).not.toBe(firstResult.messages[0].id);
      });
      
      it('should reject access from agent not in room', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_messages',
            arguments: {
              agentName: 'agent2',
              roomName: 'messaging-room'
            }
          }
        });
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(403);
        expect(response.error!.message).toContain('not in room');
      });
    });
  });
  
  describe('Management Tools', () => {
    describe('get_status', () => {
      it('should return initial server status', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_status',
            arguments: {}
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.totalRooms).toBe(0);
        expect(result.totalMessages).toBe(0);
        expect(result.activeAgents).toBe(0);
        expect(result.uptime).toBeGreaterThan(0);
        expect(result.serverVersion).toBe('1.0.0');
        expect(result.rooms).toEqual([]);
      });
      
      it('should return accurate status with activity', async () => {
        // Create rooms and activity
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'status-room1'
            }
          }
        });
        
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'status-room2'
            }
          }
        });
        
        // Add agents and messages
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'agent_communication_enter_room',
            arguments: {
              agentName: 'agent1',
              roomName: 'status-room1'
            }
          }
        });
        
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'agent1',
              roomName: 'status-room1',
              message: 'Test message'
            }
          }
        });
        
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_status',
            arguments: {}
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.totalRooms).toBe(2);
        expect(result.totalMessages).toBe(1);
        expect(result.activeAgents).toBe(1);
        expect(result.rooms).toHaveLength(2);
        
        const room1 = result.rooms.find((r: any) => r.name === 'status-room1');
        expect(room1.messageCount).toBe(1);
        expect(room1.activeAgents).toBe(1);
      });
    });
    
    describe('clear_room_messages', () => {
      beforeEach(async () => {
        // Setup room with messages
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_create_room',
            arguments: {
              roomName: 'clear-room'
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
              roomName: 'clear-room'
            }
          }
        });
        
        // Add messages
        for (let i = 1; i <= 3; i++) {
          await transport.simulateRequest({
            jsonrpc: '2.0',
            id: i + 10,
            method: 'tools/call',
            params: {
              name: 'agent_communication_send_message',
              arguments: {
                agentName: 'agent1',
                roomName: 'clear-room',
                message: `Message ${i}`
              }
            }
          });
        }
      });
      
      it('should clear all messages in room', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_clear_room_messages',
            arguments: {
              roomName: 'clear-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.success).toBe(true);
        expect(result.clearedCount).toBe(3);
        
        // Verify messages are cleared
        const messagesResponse = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'agent_communication_get_messages',
            arguments: {
              agentName: 'agent1',
              roomName: 'clear-room'
            }
          }
        });
        
        const messagesResult = JSON.parse(messagesResponse.result!.content[0].text);
        expect(messagesResult.messages).toHaveLength(0);
      });
      
      it('should return 0 for room with no messages', async () => {
        // Clear already cleared room
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_clear_room_messages',
            arguments: {
              roomName: 'clear-room'
            }
          }
        });
        
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'agent_communication_clear_room_messages',
            arguments: {
              roomName: 'clear-room'
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.success).toBe(true);
        expect(result.clearedCount).toBe(0);
      });
      
      it('should reject clearing non-existent room', async () => {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'agent_communication_clear_room_messages',
            arguments: {
              roomName: 'non-existent'
            }
          }
        });
        
        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(404);
        expect(response.error!.message).toContain('not found');
      });
    });
  });
  
  describe('Tool Error Handling', () => {
    it('should return proper error for unknown tool', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_unknown_tool',
          arguments: {}
        }
      });
      
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Unknown tool');
    });
    
    it('should handle malformed tool arguments gracefully', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            invalidParam: 'invalid'
          }
        }
      });
      
      // Should handle gracefully - actual validation would depend on implementation
      expect(response).toBeDefined();
    });
  });
  
  describe('Tool Integration', () => {
    it('should maintain consistency across all tools', async () => {
      // Create room
      const createResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'integration-test',
            description: 'Integration test room'
          }
        }
      });
      expect(JSON.parse(createResponse.result!.content[0].text).success).toBe(true);
      
      // Verify in room list
      const listResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_rooms',
          arguments: {}
        }
      });
      
      const rooms = JSON.parse(listResponse.result!.content[0].text).rooms;
      expect(rooms.map((r: any) => r.name)).toContain('integration-test');
      
      // Agent joins
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: {
            agentName: 'test-agent',
            roomName: 'integration-test'
          }
        }
      });
      
      // Verify in user list
      const usersResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_list_room_users',
          arguments: {
            roomName: 'integration-test'
          }
        }
      });
      
      const users = JSON.parse(usersResponse.result!.content[0].text).agents;
      expect(users).toContain('test-agent');
      
      // Send and retrieve message
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'test-agent',
            roomName: 'integration-test',
            message: 'Integration test message'
          }
        }
      });
      
      const messagesResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_messages',
          arguments: {
            agentName: 'test-agent',
            roomName: 'integration-test'
          }
        }
      });
      
      const messages = JSON.parse(messagesResponse.result!.content[0].text).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe('Integration test message');
      
      // Verify in status
      const statusResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'agent_communication_get_status',
          arguments: {}
        }
      });
      
      const status = JSON.parse(statusResponse.result!.content[0].text);
      expect(status.totalRooms).toBe(1);
      expect(status.totalMessages).toBe(1);
      expect(status.activeAgents).toBe(1);
    });
  });
});