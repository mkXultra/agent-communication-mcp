import { vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { JSONRPCRequest, JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MockDataLayer } from './MockDataLayer.js';
import { AppError, RoomNotFoundError, AgentNotInRoomError, RoomAlreadyExistsError, ValidationError, toMCPError } from '../../src/errors/index.js';

export class MockToolRegistry {
  constructor(private dataLayer: MockDataLayer) {}
  
  async registerAll(server: Server): Promise<void> {
    // Define the request schemas
    const listToolsRequestSchema = z.object({
      method: z.literal('tools/list'),
      params: z.object({
        _meta: z.optional(z.object({}))
      }).optional()
    });
    
    const callToolRequestSchema = z.object({
      method: z.literal('tools/call'),
      params: z.object({
        name: z.string(),
        arguments: z.any(),
        _meta: z.optional(z.object({}))
      })
    });
    
    // Register all 9 tools from spec.md
    server.setRequestHandler(listToolsRequestSchema, async (request) => ({
      tools: [
        {
          name: 'agent_communication_list_rooms',
          description: 'List all available rooms',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_create_room',
          description: 'Create a new room',
          inputSchema: {
            type: 'object',
            properties: {
              roomName: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['roomName'],
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_enter_room',
          description: 'Enter a room',
          inputSchema: {
            type: 'object',
            properties: {
              agentName: { type: 'string' },
              roomName: { type: 'string' }
            },
            required: ['agentName', 'roomName'],
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_leave_room',
          description: 'Leave a room',
          inputSchema: {
            type: 'object',
            properties: {
              agentName: { type: 'string' },
              roomName: { type: 'string' }
            },
            required: ['agentName', 'roomName'],
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_list_room_users',
          description: 'List users in a room',
          inputSchema: {
            type: 'object',
            properties: {
              roomName: { type: 'string' }
            },
            required: ['roomName'],
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_send_message',
          description: 'Send a message to a room',
          inputSchema: {
            type: 'object',
            properties: {
              agentName: { type: 'string' },
              roomName: { type: 'string' },
              message: { type: 'string' }
            },
            required: ['agentName', 'roomName', 'message'],
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_get_messages',
          description: 'Get messages from a room',
          inputSchema: {
            type: 'object',
            properties: {
              agentName: { type: 'string' },
              roomName: { type: 'string' },
              limit: { type: 'number' },
              before: { type: 'string' },
              offset: { type: 'number' }
            },
            required: ['agentName', 'roomName'],
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_get_status',
          description: 'Get server status',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        },
        {
          name: 'agent_communication_clear_room_messages',
          description: 'Clear all messages in a room',
          inputSchema: {
            type: 'object',
            properties: {
              roomName: { type: 'string' }
            },
            required: ['roomName'],
            additionalProperties: false
          }
        }
      ]
    }));
    
    server.setRequestHandler(callToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        switch (name) {
          case 'agent_communication_list_rooms':
            return { content: [{ type: 'text', text: JSON.stringify({ rooms: this.dataLayer.getAllRooms() }) }] };
          
          case 'agent_communication_create_room':
            if (this.dataLayer.roomExists(args.roomName)) {
              throw new RoomAlreadyExistsError(args.roomName);
            }
            const room = {
              name: args.roomName,
              description: args.description || '',
              createdAt: new Date().toISOString(),
              messageCount: 0
            };
            this.dataLayer.createRoom(room);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, roomName: args.roomName }) }] };
          
          case 'agent_communication_enter_room':
            if (!this.dataLayer.roomExists(args.roomName)) {
              throw new RoomNotFoundError(args.roomName);
            }
            this.dataLayer.addAgentToRoom(args.roomName, args.agentName);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
          
          case 'agent_communication_leave_room':
            if (!this.dataLayer.roomExists(args.roomName)) {
              throw new RoomNotFoundError(args.roomName);
            }
            const roomAgents = this.dataLayer.getRoomAgents(args.roomName);
            if (!roomAgents.includes(args.agentName)) {
              throw new AgentNotInRoomError(args.agentName, args.roomName);
            }
            this.dataLayer.removeAgentFromRoom(args.roomName, args.agentName);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
          
          case 'agent_communication_list_room_users':
            if (!this.dataLayer.roomExists(args.roomName)) {
              throw new RoomNotFoundError(args.roomName);
            }
            const agents = this.dataLayer.getRoomAgents(args.roomName);
            return { content: [{ type: 'text', text: JSON.stringify({ agents }) }] };
          
          case 'agent_communication_send_message':
            if (!this.dataLayer.roomExists(args.roomName)) {
              throw new RoomNotFoundError(args.roomName);
            }
            const roomUsers = this.dataLayer.getRoomAgents(args.roomName);
            if (!roomUsers.includes(args.agentName)) {
              throw new AgentNotInRoomError(args.agentName, args.roomName);
            }
            
            // Extract mentions
            const mentions = (args.message.match(/@(\w+)/g) || []).map((m: string) => m.slice(1));
            
            const message = {
              id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              agentName: args.agentName,
              roomName: args.roomName,
              message: args.message,
              timestamp: new Date().toISOString(),
              mentions
            };
            
            this.dataLayer.addMessage(args.roomName, message);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, messageId: message.id, mentions }) }] };
          
          case 'agent_communication_get_messages':
            if (!this.dataLayer.roomExists(args.roomName)) {
              throw new RoomNotFoundError(args.roomName);
            }
            const currentAgents = this.dataLayer.getRoomAgents(args.roomName);
            if (!currentAgents.includes(args.agentName)) {
              throw new AgentNotInRoomError(args.agentName, args.roomName);
            }
            
            const messages = this.dataLayer.getMessages(args.roomName, args.limit, args.before, args.offset);
            return { content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
          
          case 'agent_communication_get_status':
            const stats = this.dataLayer.getSystemStats();
            const rooms = this.dataLayer.getAllRooms().map(room => {
              const roomStats = this.dataLayer.getRoomStats(room.name);
              return {
                name: room.name,
                description: room.description,
                messageCount: roomStats.messageCount,
                activeAgents: roomStats.activeAgents,
                lastActivity: roomStats.lastActivity
              };
            });
            
            const fullStats = {
              totalRooms: stats.totalRooms,
              totalMessages: stats.totalMessages,
              activeAgents: stats.activeAgents,
              uptime: stats.uptime,
              serverVersion: stats.serverVersion,
              rooms
            };
            return { content: [{ type: 'text', text: JSON.stringify(fullStats) }] };
          
          case 'agent_communication_clear_room_messages':
            if (!args.confirm || args.confirm !== true) {
              throw new ValidationError('Confirmation required: confirm must be set to true');
            }
            if (!this.dataLayer.roomExists(args.roomName)) {
              throw new RoomNotFoundError(args.roomName);
            }
            const clearedCount = this.dataLayer.clearMessages(args.roomName);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, roomName: args.roomName, clearedCount }) }] };
          
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof AppError) {
          const mcpError = toMCPError(error);
          // Create an error object that matches MCP SDK expectations
          const err = new Error(mcpError.message);
          (err as any).code = mcpError.code;
          (err as any).data = mcpError.data;
          throw err;
        }
        throw error;
      }
    });
  }
}