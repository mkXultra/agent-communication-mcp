import { vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { JSONRPCRequest, JSONRPCResponse, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
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
          name: 'agent_communication_wait_for_messages',
          description: 'Wait for new messages in a room',
          inputSchema: {
            type: 'object',
            properties: {
              agentName: { type: 'string' },
              roomName: { type: 'string' },
              timeout: { type: 'number' }
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
        // Validate that the tool exists
        const validTools = [
          'agent_communication_list_rooms',
          'agent_communication_create_room',
          'agent_communication_enter_room',
          'agent_communication_leave_room',
          'agent_communication_list_room_users',
          'agent_communication_send_message',
          'agent_communication_get_messages',
          'agent_communication_wait_for_messages',
          'agent_communication_get_status',
          'agent_communication_clear_room_messages'
        ];
        
        if (!validTools.includes(name)) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        
        // Basic input validation for required fields
        switch (name) {
          case 'agent_communication_create_room':
            if (!args?.roomName || typeof args.roomName !== 'string' || args.roomName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name cannot be empty');
            }
            // Validate room name format (alphanumeric, hyphens, underscores only)
            if (!/^[a-zA-Z0-9-_]+$/.test(args.roomName)) {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name must contain only alphanumeric characters, hyphens, and underscores');
            }
            // Validate room name length
            if (args.roomName.length > 50) {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name cannot exceed 50 characters');
            }
            break;
          case 'agent_communication_enter_room':
          case 'agent_communication_leave_room':
            if (!args?.agentName || typeof args.agentName !== 'string' || args.agentName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Agent name cannot be empty');
            }
            if (!args?.roomName || typeof args.roomName !== 'string' || args.roomName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name cannot be empty');
            }
            break;
          case 'agent_communication_send_message':
            if (!args?.agentName || typeof args.agentName !== 'string' || args.agentName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Agent name cannot be empty');
            }
            if (!args?.roomName || typeof args.roomName !== 'string' || args.roomName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name cannot be empty');
            }
            if (!args?.message || typeof args.message !== 'string') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Message cannot be empty');
            }
            break;
          case 'agent_communication_get_messages':
            if (!args?.agentName || typeof args.agentName !== 'string' || args.agentName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Agent name cannot be empty');
            }
            if (!args?.roomName || typeof args.roomName !== 'string' || args.roomName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name cannot be empty');
            }
            if (args.limit !== undefined && (typeof args.limit !== 'number' || args.limit < 1 || args.limit > 1000)) {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Limit must be between 1 and 1000');
            }
            if (args.before !== undefined && typeof args.before !== 'string') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Before parameter must be a string');
            }
            break;
          case 'agent_communication_wait_for_messages':
            if (!args?.agentName || typeof args.agentName !== 'string' || args.agentName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Agent name cannot be empty');
            }
            if (!args?.roomName || typeof args.roomName !== 'string' || args.roomName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name cannot be empty');
            }
            if (args.timeout !== undefined && (typeof args.timeout !== 'number' || args.timeout < 0)) {
               throw new McpError(ErrorCode.InvalidParams, 'Validation error: Timeout must be a positive number');
            }
            break;
          case 'agent_communication_list_room_users':
          case 'agent_communication_clear_room_messages':
            if (!args?.roomName || typeof args.roomName !== 'string' || args.roomName.trim() === '') {
              throw new McpError(ErrorCode.InvalidParams, 'Validation error: Room name cannot be empty');
            }
            break;
        }
        
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
          
          case 'agent_communication_wait_for_messages':
            if (!this.dataLayer.roomExists(args.roomName)) {
              throw new RoomNotFoundError(args.roomName);
            }
            const waitingAgents = this.dataLayer.getRoomAgents(args.roomName);
            if (!waitingAgents.includes(args.agentName)) {
               throw new AgentNotInRoomError(args.agentName, args.roomName);
            }
            // Mock immediate timeout response
            return { content: [{ type: 'text', text: JSON.stringify({ messages: [], hasNewMessages: false, timedOut: true }) }] };

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
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        // If it's already a McpError, just throw it
        if (error instanceof McpError) {
          throw error;
        }
        
        // Convert AppError to McpError
        if (error instanceof AppError) {
          // Map HTTP status codes to MCP error codes
          // 404 for resources (rooms, agents) should be InvalidParams, not MethodNotFound
          const errorCode = error.statusCode >= 400 && error.statusCode < 500 ? ErrorCode.InvalidParams :
                          ErrorCode.InternalError;
          throw new McpError(
            errorCode,
            error.message,
            { errorCode: error.code }
          );
        }
        
        // Handle any other errors
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Internal server error',
          { errorCode: 'INTERNAL_ERROR' }
        );
      }
    });
  }
}