// Agent Communication MCP Server - スキーマバリデーションテスト

import { describe, it, expect } from 'vitest';
import {
  createRoomInputSchema,
  createRoomOutputSchema,
  sendMessageInputSchema,
  sendMessageOutputSchema,
  getMessagesInputSchema,
  getMessagesOutputSchema,
  enterRoomInputSchema,
  listRoomUsersInputSchema,
  getStatusInputSchema,
  clearRoomMessagesInputSchema,
} from '../../src/schemas';

describe('Schema Validation Tests', () => {
  describe('Room Schema Validation', () => {
    it('should validate create_room input schema', () => {
      const validInput = {
        roomName: 'test-room',
        description: 'A test room',
      };

      const result = createRoomInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.roomName).toBe('test-room');
        expect(result.data.description).toBe('A test room');
      }
    });

    it('should reject invalid room names', () => {
      const invalidInputs = [
        { roomName: '' }, // empty
        { roomName: 'room with spaces' }, // spaces
        { roomName: 'room@with@symbols' }, // invalid characters
        { roomName: 'a'.repeat(51) }, // too long
      ];

      invalidInputs.forEach(input => {
        const result = createRoomInputSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.length).toBeGreaterThan(0);
        }
      });
    });

    it('should validate create_room output schema', () => {
      const validOutput = {
        success: true,
        roomName: 'test-room',
        description: 'A test room',
        createdAt: '2023-01-01T00:00:00Z',
      };

      const result = createRoomOutputSchema.safeParse(validOutput);
      expect(result.success).toBe(true);
    });

    it('should validate enter_room input schema', () => {
      const validInput = {
        agentName: 'alice',
        roomName: 'test-room',
        profile: {
          role: 'developer',
          description: 'Senior developer',
          capabilities: ['TypeScript', 'React'],
          metadata: { team: 'frontend' },
        },
      };

      const result = enterRoomInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('should validate enter_room input without profile', () => {
      const validInput = {
        agentName: 'alice',
        roomName: 'test-room',
        // profile is optional
      };

      const result = enterRoomInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('should validate list_room_users input schema', () => {
      const validInput = {
        roomName: 'test-room',
      };

      const result = listRoomUsersInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });
  });

  describe('Message Schema Validation', () => {
    it('should validate send_message input schema', () => {
      const validInput = {
        agentName: 'alice',
        roomName: 'test-room',
        message: 'Hello @bob, how are you?',
        metadata: { priority: 'high', category: 'greeting' },
      };

      const result = sendMessageInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agentName).toBe('alice');
        expect(result.data.message).toContain('@bob');
        expect(result.data.metadata?.priority).toBe('high');
      }
    });

    it('should reject invalid message content', () => {
      const invalidInputs = [
        {
          agentName: 'alice',
          roomName: 'test-room',
          message: '', // empty message
        },
        {
          agentName: 'alice',
          roomName: 'test-room',
          message: 'x'.repeat(2001), // too long
        },
        {
          agentName: '', // empty agent name
          roomName: 'test-room',
          message: 'Hello',
        },
        {
          agentName: 'alice',
          roomName: 'invalid room name!', // invalid room name
          message: 'Hello',
        },
      ];

      invalidInputs.forEach(input => {
        const result = sendMessageInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    });

    it('should validate send_message output schema', () => {
      const validOutput = {
        success: true,
        messageId: 'msg-123',
        roomName: 'test-room',
        agentName: 'alice',
        timestamp: '2023-01-01T00:00:00Z',
        mentions: ['bob', 'charlie'],
      };

      const result = sendMessageOutputSchema.safeParse(validOutput);
      expect(result.success).toBe(true);
    });

    it('should validate get_messages input schema', () => {
      const validInput = {
        roomName: 'test-room',
        agentName: 'alice',
        limit: 50,
        cursor: 'cursor-123',
        since: '2023-01-01T00:00:00Z',
        includeMetadata: true,
      };

      const result = getMessagesInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('should validate get_messages with minimal input', () => {
      const minimalInput = {
        roomName: 'test-room',
        // all other fields are optional
      };

      const result = getMessagesInputSchema.safeParse(minimalInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50); // default value
        expect(result.data.offset).toBe(0); // default value
        expect(result.data.mentionsOnly).toBe(false); // default value
      }
    });

    it('should reject invalid limit values', () => {
      const invalidInputs = [
        { roomName: 'test-room', limit: 0 }, // too small
        { roomName: 'test-room', limit: 1001 }, // too large
        { roomName: 'test-room', limit: -1 }, // negative
      ];

      invalidInputs.forEach(input => {
        const result = getMessagesInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    });

    it('should validate get_messages output schema', () => {
      const validOutput = {
        roomName: 'test-room',
        messages: [
          {
            id: 'msg-123',
            roomName: 'test-room',
            agentName: 'alice',
            message: 'Hello world',
            mentions: [],
            timestamp: '2023-01-01T00:00:00Z',
            metadata: { priority: 'high' },
          },
        ],
        count: 1,
        hasMore: false,
      };

      const result = getMessagesOutputSchema.safeParse(validOutput);
      expect(result.success).toBe(true);
    });
  });

  describe('Management Schema Validation', () => {
    it('should validate get_status input schema', () => {
      const validInputs = [
        {}, // empty - all optional
        { roomName: 'test-room' }, // with room name
      ];

      validInputs.forEach(input => {
        const result = getStatusInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      });
    });

    it('should validate clear_room_messages input schema', () => {
      const validInput = {
        roomName: 'test-room',
        confirm: true,
      };

      const result = clearRoomMessagesInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.confirm).toBe(true);
      }
    });

    it('should validate clear_room_messages with minimal input', () => {
      const minimalInput = {
        roomName: 'test-room',
        confirm: true,  // confirm is required
      };

      const result = clearRoomMessagesInputSchema.safeParse(minimalInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.confirm).toBe(true);
      }
    });

    it('should reject invalid timestamp format', () => {
      const invalidInput = {
        roomName: 'test-room',
        olderThan: 'invalid-date',
      };

      const result = clearRoomMessagesInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('Common Validation Rules', () => {
    it('should enforce room name pattern across schemas', () => {
      const validRoomNames = [
        'general',
        'test-room',
        'room_123',
        'UPPERCASE',
        'mixed-Case_123',
      ];

      const invalidRoomNames = [
        'room with spaces',
        'room@domain',
        'room.name',
        'room+plus',
        'room/slash',
        'room\\backslash',
      ];

      // Test with create_room schema
      validRoomNames.forEach(roomName => {
        const result = createRoomInputSchema.safeParse({ roomName });
        expect(result.success).toBe(true);
      });

      invalidRoomNames.forEach(roomName => {
        const result = createRoomInputSchema.safeParse({ roomName });
        expect(result.success).toBe(false);
      });
    });

    it('should enforce agent name constraints across schemas', () => {
      const validAgentNames = [
        'alice',
        'agent-123',
        'Agent_Name',
        'a'.repeat(50), // max length
      ];

      const invalidAgentNames = [
        '', // empty
        'a'.repeat(51), // too long
      ];

      // Test with send_message schema
      validAgentNames.forEach(agentName => {
        const result = sendMessageInputSchema.safeParse({
          agentName,
          roomName: 'test-room',
          message: 'test',
        });
        expect(result.success).toBe(true);
      });

      invalidAgentNames.forEach(agentName => {
        const result = sendMessageInputSchema.safeParse({
          agentName,
          roomName: 'test-room',
          message: 'test',
        });
        expect(result.success).toBe(false);
      });
    });
  });
});