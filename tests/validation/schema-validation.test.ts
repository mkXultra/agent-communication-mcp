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

    // enter_room の profile の上限は agora docs/api.yaml の `AgentProfile` に合わせる（0.7.0）。
    describe('enter_room profile limits (agora AgentProfile)', () => {
      const parse = (profile: unknown) =>
        enterRoomInputSchema.safeParse({ agentName: 'alice', roomName: 'test-room', profile });

      it('accepts a profile at the limits', () => {
        const result = parse({
          role: 'r'.repeat(100),
          description: 'd'.repeat(500),
          capabilities: Array.from({ length: 50 }, () => 'c'.repeat(100)),
          metadata: { nested: { team: 'frontend' } },
        });
        expect(result.success).toBe(true);
      });

      it.each([
        ['role over 100 characters', { role: 'r'.repeat(101) }, 'Profile role cannot exceed 100 characters'],
        [
          'description over 500 characters',
          { description: 'd'.repeat(501) },
          'Profile description cannot exceed 500 characters',
        ],
        [
          'over 50 capabilities',
          { capabilities: Array.from({ length: 51 }, () => 'c') },
          'Profile capabilities cannot exceed 50 items',
        ],
        [
          'a capability over 100 characters',
          { capabilities: ['c'.repeat(101)] },
          'Each capability cannot exceed 100 characters',
        ],
      ])('rejects %s', (_label, profile, message) => {
        const result = parse(profile);
        expect(result.success).toBe(false);
        expect(result.error!.issues.map((issue) => issue.message)).toContain(message);
      });

      // agora counts code points (`codePointLength`), so an emoji is one character, not the two UTF-16 units it takes.
      it('counts the limits in code points, not UTF-16 code units', () => {
        const emoji = String.fromCodePoint(0x1f600);
        // 60 emoji are 60 code points but 120 UTF-16 code units: agora accepts this role, so we must too.
        expect(parse({ role: emoji.repeat(60) }).success).toBe(true);
        expect(parse({ description: emoji.repeat(300) }).success).toBe(true);
        expect(parse({ capabilities: [emoji.repeat(60)] }).success).toBe(true);

        const tooBig = parse({ role: emoji.repeat(101) });
        expect(tooBig.success).toBe(false);
        expect(tooBig.error!.issues.map((issue) => issue.message)).toContain('Profile role cannot exceed 100 characters');
        expect(parse({ description: emoji.repeat(501) }).success).toBe(false);
        expect(parse({ capabilities: [emoji.repeat(101)] }).success).toBe(false);
      });

      it('rejects an unknown key (additionalProperties: false on the tool schema)', () => {
        const result = parse({ role: 'reviewer', nickname: 'al' });
        expect(result.success).toBe(false);
        expect(result.error!.issues[0]).toMatchObject({
          code: 'unrecognized_keys',
          keys: ['nickname'],
          path: ['profile'],
        });
      });

      it('keeps the profile in the parsed output so the handler can forward it', () => {
        const profile = { role: 'reviewer', description: 'claude-opus / mac-mini, reviews PRs' };
        const result = enterRoomInputSchema.parse({ agentName: 'alice', roomName: 'test-room', profile });
        expect(result).toEqual({ agentName: 'alice', roomName: 'test-room', profile });
      });
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
          message: 'x'.repeat(10001), // too long
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

    it('should count the send_message length in code points (10000 at most)', () => {
      const emoji = String.fromCodePoint(0x1f600);
      const input = { agentName: 'alice', roomName: 'test-room', message: emoji.repeat(10000) };
      expect(sendMessageInputSchema.safeParse(input).success).toBe(true);
      expect(sendMessageInputSchema.safeParse({ ...input, message: 'x'.repeat(10000) }).success).toBe(true);

      const over = sendMessageInputSchema.safeParse({ ...input, message: emoji.repeat(10001) });
      expect(over.success).toBe(false);
      if (!over.success) {
        expect(over.error.issues).toEqual([
          expect.objectContaining({ code: 'too_big', maximum: 10000, path: ['message'], message: 'Message cannot exceed 10000 characters' }),
        ]);
      }
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
        expect(result.data.limit).toBe(20); // default value
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