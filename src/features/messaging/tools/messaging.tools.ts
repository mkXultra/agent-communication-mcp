import { z } from 'zod';
import { MessagingAPI } from '../index';
import { sendMessageSchema, getMessagesSchema } from '../MessageValidator';

// MCP Tool definitions for messaging functionality
export const messagingTools = [
  {
    name: 'agent_communication/send_message',
    description: 'Send a message to a room with mention support',
    inputSchema: {
      type: 'object',
      properties: {
        agentName: {
          type: 'string',
          description: 'Name of the sending agent',
          minLength: 1,
          maxLength: 50
        },
        roomName: {
          type: 'string',
          description: 'Name of the target room',
          pattern: '^[a-zA-Z0-9-_]+$'
        },
        message: {
          type: 'string',
          description: 'Message content (supports @mentions)',
          minLength: 1,
          maxLength: 1000
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata',
          additionalProperties: true
        }
      },
      required: ['agentName', 'roomName', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'agent_communication/get_messages',
    description: 'Retrieve messages from a room with pagination and filtering',
    inputSchema: {
      type: 'object',
      properties: {
        roomName: {
          type: 'string',
          description: 'Name of the room',
          pattern: '^[a-zA-Z0-9-_]+$'
        },
        agentName: {
          type: 'string',
          description: 'Agent name for mention filtering',
          minLength: 1,
          maxLength: 50
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to retrieve',
          minimum: 1,
          maximum: 1000,
          default: 50
        },
        offset: {
          type: 'number',
          description: 'Number of messages to skip',
          minimum: 0,
          default: 0
        },
        mentionsOnly: {
          type: 'boolean',
          description: 'Only retrieve messages that mention the specified agent',
          default: false
        }
      },
      required: ['roomName'],
      additionalProperties: false
    }
  }
] as const;

// Tool handler functions
export class MessagingToolHandlers {
  private messagingAPI: MessagingAPI;

  constructor(dataDir?: string, cacheCapacity?: number) {
    this.messagingAPI = new MessagingAPI(dataDir, cacheCapacity);
  }

  async handleSendMessage(args: unknown) {
    try {
      const params = sendMessageSchema.parse(args);
      const result = await this.messagingAPI.sendMessage(params);
      
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: result.success,
              messageId: result.messageId,
              roomName: result.roomName,
              timestamp: result.timestamp,
              mentions: result.mentions
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              message: error instanceof Error ? error.message : 'Unknown error',
              code: error instanceof Error && 'code' in error ? error.code : 'UNKNOWN_ERROR'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  }

  async handleGetMessages(args: unknown) {
    try {
      const params = getMessagesSchema.parse(args);
      const result = await this.messagingAPI.getMessages(params);
      
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              roomName: result.roomName,
              messages: result.messages,
              count: result.count,
              hasMore: result.hasMore
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              message: error instanceof Error ? error.message : 'Unknown error',
              code: error instanceof Error && 'code' in error ? error.code : 'UNKNOWN_ERROR'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  }

  // Get all tool handlers
  getHandlers() {
    return {
      'agent_communication/send_message': this.handleSendMessage.bind(this),
      'agent_communication/get_messages': this.handleGetMessages.bind(this)
    };
  }
}

// Default instance
export const messagingToolHandlers = new MessagingToolHandlers();

// Export individual handlers for convenience
export const sendMessageHandler = messagingToolHandlers.handleSendMessage.bind(messagingToolHandlers);
export const getMessagesHandler = messagingToolHandlers.handleGetMessages.bind(messagingToolHandlers);