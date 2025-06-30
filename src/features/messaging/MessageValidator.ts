import { z } from 'zod';
import { ValidationError } from '../../errors/AppError';
import { SendMessageParams, GetMessagesParams, WaitForMessagesParams } from './types/messaging.types';
import { WAIT_CONSTANTS } from './constants';

export const sendMessageSchema = z.object({
  agentName: z.string().min(1).max(50),
  roomName: z.string().min(1).regex(/^[a-zA-Z0-9-_]+$/),
  message: z.string().min(1).max(2000),
  metadata: z.record(z.any()).optional()
});

export const getMessagesSchema = z.object({
  roomName: z.string().min(1).regex(/^[a-zA-Z0-9-_]+$/),
  agentName: z.string().min(1).max(50).optional(),
  limit: z.number().int().min(1).max(1000).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  mentionsOnly: z.boolean().optional().default(false)
});

export const waitForMessagesSchema = z.object({
  agentName: z.string().min(1).max(50).regex(/^[a-zA-Z0-9-_]+$/),
  roomName: z.string().min(1).regex(/^[a-zA-Z0-9-_]+$/),
  timeout: z.number().int().min(WAIT_CONSTANTS.MIN_TIMEOUT).max(WAIT_CONSTANTS.MAX_TIMEOUT).optional()
});

export class MessageValidator {
  static validateSendMessage(params: unknown): SendMessageParams {
    try {
      return sendMessageSchema.parse(params);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        if (firstError) {
          if (firstError.path[0] === 'roomName' && firstError.code === 'too_small') {
            throw new ValidationError('roomName', 'Room name is required and must be a string');
          }
          throw new ValidationError(firstError.path.join('.'), firstError.message);
        }
        throw new ValidationError('validation_failed', 'Validation failed');
      }
      throw error;
    }
  }

  static validateGetMessages(params: unknown): GetMessagesParams {
    try {
      return getMessagesSchema.parse(params);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        if (firstError) {
          throw new ValidationError(firstError.path.join('.'), firstError.message);
        }
        throw new ValidationError('validation_failed', 'Validation failed');
      }
      throw error;
    }
  }

  static validateWaitForMessages(params: unknown): WaitForMessagesParams {
    try {
      return waitForMessagesSchema.parse(params);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        if (firstError) {
          if (firstError.path[0] === 'agentName' && firstError.code === 'too_small') {
            throw new ValidationError('agentName', 'Agent name is required and must be a string');
          }
          if (firstError.path[0] === 'roomName' && firstError.code === 'too_small') {
            throw new ValidationError('roomName', 'Room name is required and must be a string');
          }
          throw new ValidationError(firstError.path.join('.'), firstError.message);
        }
        throw new ValidationError('validation_failed', 'Validation failed');
      }
      throw error;
    }
  }

  static extractMentions(message: string): string[] {
    const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
    const mentions: string[] = [];
    let match;
    
    while ((match = mentionRegex.exec(message)) !== null) {
      if (match[1]) {
        mentions.push(match[1]);
      }
    }
    
    // Remove duplicates
    return [...new Set(mentions)];
  }
}