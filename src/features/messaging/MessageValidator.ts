import { z } from 'zod';
import { ValidationError } from '../../errors/AppError';
import { SendMessageParams, GetMessagesParams } from './types/messaging.types';

export const sendMessageSchema = z.object({
  agentName: z.string().min(1).max(50),
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/),
  message: z.string().min(1).max(1000),
  metadata: z.record(z.any()).optional()
});

export const getMessagesSchema = z.object({
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/),
  agentName: z.string().min(1).max(50).optional(),
  limit: z.number().int().min(1).max(1000).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  mentionsOnly: z.boolean().optional().default(false)
});

export class MessageValidator {
  static validateSendMessage(params: unknown): SendMessageParams {
    try {
      return sendMessageSchema.parse(params);
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