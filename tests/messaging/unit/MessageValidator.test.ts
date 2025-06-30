import { describe, it, expect } from 'vitest';
import { MessageValidator } from '../../../src/features/messaging/MessageValidator';
import { ValidationError } from '../../../src/errors/AppError';

describe('MessageValidator', () => {
  describe('validateSendMessage', () => {
    it('should validate valid send message parameters', () => {
      const validParams = {
        agentName: 'test-agent',
        roomName: 'test-room',
        message: 'Hello world!'
      };

      const result = MessageValidator.validateSendMessage(validParams);
      expect(result).toEqual(validParams);
    });

    it('should validate send message with metadata', () => {
      const validParams = {
        agentName: 'test-agent',
        roomName: 'test-room',
        message: 'Hello world!',
        metadata: { priority: 'high', category: 'announcement' }
      };

      const result = MessageValidator.validateSendMessage(validParams);
      expect(result).toEqual(validParams);
    });

    it('should throw ValidationError for empty agent name', () => {
      const invalidParams = {
        agentName: '',
        roomName: 'test-room',
        message: 'Hello world!'
      };

      expect(() => MessageValidator.validateSendMessage(invalidParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError for agent name too long', () => {
      const invalidParams = {
        agentName: 'a'.repeat(51),
        roomName: 'test-room',
        message: 'Hello world!'
      };

      expect(() => MessageValidator.validateSendMessage(invalidParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid room name', () => {
      const invalidParams = {
        agentName: 'test-agent',
        roomName: 'test room!',
        message: 'Hello world!'
      };

      expect(() => MessageValidator.validateSendMessage(invalidParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError for empty message', () => {
      const invalidParams = {
        agentName: 'test-agent',
        roomName: 'test-room',
        message: ''
      };

      expect(() => MessageValidator.validateSendMessage(invalidParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError for message too long', () => {
      const invalidParams = {
        agentName: 'test-agent',
        roomName: 'test-room',
        message: 'a'.repeat(2001)
      };

      expect(() => MessageValidator.validateSendMessage(invalidParams)).toThrow(ValidationError);
    });
  });

  describe('validateGetMessages', () => {
    it('should validate valid get messages parameters', () => {
      const validParams = {
        roomName: 'test-room'
      };

      const result = MessageValidator.validateGetMessages(validParams);
      expect(result.roomName).toBe('test-room');
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
      expect(result.mentionsOnly).toBe(false);
    });

    it('should validate get messages with all parameters', () => {
      const validParams = {
        roomName: 'test-room',
        agentName: 'test-agent',
        limit: 100,
        offset: 20,
        mentionsOnly: true
      };

      const result = MessageValidator.validateGetMessages(validParams);
      expect(result).toEqual(validParams);
    });

    it('should throw ValidationError for invalid room name', () => {
      const invalidParams = {
        roomName: 'test room!'
      };

      expect(() => MessageValidator.validateGetMessages(invalidParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError for limit too large', () => {
      const invalidParams = {
        roomName: 'test-room',
        limit: 1001
      };

      expect(() => MessageValidator.validateGetMessages(invalidParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError for negative offset', () => {
      const invalidParams = {
        roomName: 'test-room',
        offset: -1
      };

      expect(() => MessageValidator.validateGetMessages(invalidParams)).toThrow(ValidationError);
    });
  });

  describe('extractMentions', () => {
    it('should extract mentions from message', () => {
      const message = 'Hello @alice and @bob, how are you?';
      const mentions = MessageValidator.extractMentions(message);
      expect(mentions).toEqual(['alice', 'bob']);
    });

    it('should extract mentions with underscores and hyphens', () => {
      const message = 'Hey @test_agent and @another-agent!';
      const mentions = MessageValidator.extractMentions(message);
      expect(mentions).toEqual(['test_agent', 'another-agent']);
    });

    it('should handle duplicate mentions', () => {
      const message = 'Hello @alice, @bob, and @alice again!';
      const mentions = MessageValidator.extractMentions(message);
      expect(mentions).toEqual(['alice', 'bob']);
    });

    it('should return empty array for no mentions', () => {
      const message = 'Hello everyone!';
      const mentions = MessageValidator.extractMentions(message);
      expect(mentions).toEqual([]);
    });

    it('should handle mentions at start and end', () => {
      const message = '@alice hello @bob';
      const mentions = MessageValidator.extractMentions(message);
      expect(mentions).toEqual(['alice', 'bob']);
    });
  });
});