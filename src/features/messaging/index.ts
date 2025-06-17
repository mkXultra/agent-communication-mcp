import { MessageService } from './MessageService';
import {
  SendMessageParams,
  SendMessageResponse,
  GetMessagesParams,
  MessageListResponse,
  Message
} from './types/messaging.types';

// Public API interface
export interface IMessagingAPI {
  sendMessage(params: SendMessageParams): Promise<SendMessageResponse>;
  getMessages(params: GetMessagesParams): Promise<MessageListResponse>;
  getMessageCount(roomName: string): Promise<number>;
}

// Implementation of the public API
export class MessagingAPI implements IMessagingAPI {
  private readonly messageService: MessageService;

  constructor(dataDir?: string, cacheCapacity?: number) {
    this.messageService = new MessageService(dataDir, cacheCapacity);
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    return await this.messageService.sendMessage(params);
  }

  async getMessages(params: GetMessagesParams): Promise<MessageListResponse> {
    return await this.messageService.getMessages(params);
  }

  async getMessageCount(roomName: string): Promise<number> {
    return await this.messageService.getMessageCount(roomName);
  }
}

// Export types
export type {
  SendMessageParams,
  SendMessageResponse,
  GetMessagesParams,
  MessageListResponse,
  Message
};

// Export services
export { MessageService } from './MessageService';
export { MessageStorage } from './MessageStorage';
export { MessageCache } from './MessageCache';
export { MessageValidator } from './MessageValidator';

// Export MCP tools
export { messagingTools, MessagingToolHandlers, messagingToolHandlers } from './tools/messaging.tools';

// Export default API instance
export const messagingAPI = new MessagingAPI();