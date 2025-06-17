// Agent Communication MCP Server - 型定義整合性テスト

import { describe, it, expect } from 'vitest';
import type {
  Room,
  Message,
  Agent,
  AgentProfile,
  Presence,
  IStorageService,
  IRoomService,
  IMessageService,
  IManagementService,
  MCPTools,
} from '../../src/types';

import {
  AppError,
  RoomNotFoundError,
  AgentNotInRoomError,
  ValidationError,
  toMCPError,
} from '../../src/errors';

describe('Type Definitions Validation', () => {
  describe('Basic Entity Types', () => {
    it('should create valid Room object', () => {
      const room: Room = {
        name: 'test-room',
        description: 'Test room',
        createdAt: '2023-01-01T00:00:00Z',
        messageCount: 10,
        userCount: 3,
      };

      expect(room.name).toBe('test-room');
      expect(room.messageCount).toBe(10);
      expect(room.userCount).toBe(3);
    });

    it('should create valid Message object', () => {
      const message: Message = {
        id: 'msg-123',
        roomName: 'test-room',
        agentName: 'alice',
        message: 'Hello @bob!',
        mentions: ['bob'],
        timestamp: '2023-01-01T00:00:00Z',
        metadata: { priority: 'high' },
      };

      expect(message.id).toBe('msg-123');
      expect(message.mentions).toContain('bob');
      expect(message.metadata?.priority).toBe('high');
    });

    it('should create valid Agent object', () => {
      const agent: Agent = {
        name: 'alice',
        profile: {
          role: 'developer',
          description: 'Senior developer',
          capabilities: ['TypeScript', 'React'],
          metadata: { team: 'frontend' },
        },
      };

      expect(agent.name).toBe('alice');
      expect(agent.profile?.role).toBe('developer');
      expect(agent.profile?.capabilities).toContain('TypeScript');
    });

    it('should create valid Presence object', () => {
      const presence: Presence = {
        agentName: 'alice',
        status: 'online',
        joinedAt: '2023-01-01T00:00:00Z',
        messageCount: 5,
        profile: {
          role: 'developer',
        },
      };

      expect(presence.agentName).toBe('alice');
      expect(presence.status).toBe('online');
      expect(presence.messageCount).toBe(5);
    });
  });

  describe('Service Interface Types', () => {
    it('should validate IStorageService interface shape', () => {
      // TypeScript型チェック用のダミー実装
      const mockStorageService: IStorageService = {
        async readJSON<T>(path: string): Promise<T> {
          return {} as T;
        },
        async writeJSON<T>(path: string, data: T): Promise<void> {
          // Mock implementation
        },
        async appendJSONL(path: string, data: any): Promise<void> {
          // Mock implementation
        },
        async readJSONL<T>(path: string, options?: any): Promise<T[]> {
          return [];
        },
        async withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
          return await operation();
        },
        async exists(path: string): Promise<boolean> {
          return true;
        },
        async ensureDir(path: string): Promise<void> {
          // Mock implementation
        },
      };

      expect(typeof mockStorageService.readJSON).toBe('function');
      expect(typeof mockStorageService.writeJSON).toBe('function');
      expect(typeof mockStorageService.withLock).toBe('function');
    });

    it('should validate IRoomService interface shape', () => {
      const mockRoomService: IRoomService = {
        async createRoom(roomName: string, description?: string): Promise<Room> {
          return {
            name: roomName,
            description,
            createdAt: '2023-01-01T00:00:00Z',
            messageCount: 0,
            userCount: 0,
          };
        },
        async listRooms(agentName?: string): Promise<any> {
          return { rooms: [], total: 0 };
        },
        async deleteRoom(roomName: string): Promise<void> {
          // Mock implementation
        },
        async enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<void> {
          // Mock implementation
        },
        async leaveRoom(agentName: string, roomName: string): Promise<void> {
          // Mock implementation
        },
        async listRoomUsers(roomName: string): Promise<Presence[]> {
          return [];
        },
        async updatePresence(roomName: string, agentName: string, status: 'online' | 'offline'): Promise<void> {
          // Mock implementation
        },
      };

      expect(typeof mockRoomService.createRoom).toBe('function');
      expect(typeof mockRoomService.enterRoom).toBe('function');
      expect(typeof mockRoomService.listRoomUsers).toBe('function');
    });
  });

  describe('MCP Tool Types', () => {
    it('should validate send_message tool types', () => {
      const input: MCPTools['send_message']['input'] = {
        agentName: 'alice',
        roomName: 'test-room',
        message: 'Hello world!',
        metadata: { priority: 'high' },
      };

      const output: MCPTools['send_message']['output'] = {
        success: true,
        messageId: 'msg-123',
        roomName: 'test-room',
        agentName: 'alice',
        timestamp: '2023-01-01T00:00:00Z',
        mentions: [],
      };

      expect(input.agentName).toBe('alice');
      expect(input.roomName).toBe('test-room');
      expect(output.success).toBe(true);
      expect(output.messageId).toBe('msg-123');
    });

    it('should validate get_messages tool types', () => {
      const input: MCPTools['get_messages']['input'] = {
        roomName: 'test-room',
        agentName: 'alice',
        limit: 50,
        cursor: 'cursor-123',
        since: '2023-01-01T00:00:00Z',
        includeMetadata: true,
      };

      const output: MCPTools['get_messages']['output'] = {
        messages: [],
        total: 0,
        hasMore: false,
        cursor: 'next-cursor',
      };

      expect(input.roomName).toBe('test-room');
      expect(input.limit).toBe(50);
      expect(output.messages).toEqual([]);
      expect(output.hasMore).toBe(false);
    });
  });

  describe('Error Types', () => {
    it('should create and handle custom errors', () => {
      const roomError = new RoomNotFoundError('test-room');
      expect(roomError).toBeInstanceOf(AppError);
      expect(roomError).toBeInstanceOf(RoomNotFoundError);
      expect(roomError.message).toContain('test-room');
      expect(roomError.code).toBe('ROOM_NOT_FOUND');
      expect(roomError.statusCode).toBe(404);
    });

    it('should create and handle agent errors', () => {
      const agentError = new AgentNotInRoomError('alice', 'private-room');
      expect(agentError).toBeInstanceOf(AppError);
      expect(agentError.message).toContain('alice');
      expect(agentError.message).toContain('private-room');
      expect(agentError.code).toBe('AGENT_NOT_IN_ROOM');
    });

    it('should convert AppError to MCP error format', () => {
      const error = new ValidationError('roomName', 'Invalid format');
      const mcpError = toMCPError(error);

      expect(mcpError.code).toBe(400);
      expect(mcpError.message).toContain('roomName');
      expect(mcpError.data?.errorCode).toBe('VALIDATION_ERROR');
    });

    it('should handle generic errors', () => {
      const genericError = new Error('Something went wrong');
      const mcpError = toMCPError(genericError);

      expect(mcpError.code).toBe(500);
      expect(mcpError.message).toBe('Internal server error');
      expect(mcpError.data?.errorCode).toBe('INTERNAL_ERROR');
    });
  });

  describe('Type Constraints', () => {
    it('should enforce presence status constraints', () => {
      const onlinePresence: Presence = {
        agentName: 'alice',
        status: 'online',
        joinedAt: '2023-01-01T00:00:00Z',
        messageCount: 0,
      };

      const offlinePresence: Presence = {
        agentName: 'bob',
        status: 'offline',
        joinedAt: '2023-01-01T00:00:00Z',
        messageCount: 0,
      };

      expect(onlinePresence.status).toBe('online');
      expect(offlinePresence.status).toBe('offline');

      // TypeScript should prevent invalid status values at compile time
      // const invalidPresence: Presence = {
      //   agentName: 'charlie',
      //   status: 'away', // This should cause a TypeScript error
      //   joinedAt: '2023-01-01T00:00:00Z',
      //   messageCount: 0,
      // };
    });

    it('should handle optional fields correctly', () => {
      const minimalRoom: Room = {
        name: 'minimal',
        createdAt: '2023-01-01T00:00:00Z',
        messageCount: 0,
        userCount: 0,
        // description is optional
      };

      const fullRoom: Room = {
        name: 'full',
        description: 'A complete room',
        createdAt: '2023-01-01T00:00:00Z',
        messageCount: 10,
        userCount: 5,
      };

      expect(minimalRoom.description).toBeUndefined();
      expect(fullRoom.description).toBe('A complete room');
    });
  });
});