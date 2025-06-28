import { MessageService } from './MessageService';
import {
  SendMessageParams,
  SendMessageResponse,
  GetMessagesParams,
  MessageListResponse,
  Message,
  WaitForMessagesParams,
  WaitForMessagesResponse
} from './types/messaging.types';
import { LockService } from '../../services/LockService';
import { getDataDirectory } from '../../utils/dataDir';

// Public API interface
export interface IMessagingAPI {
  sendMessage(params: SendMessageParams): Promise<SendMessageResponse>;
  getMessages(params: GetMessagesParams): Promise<MessageListResponse>;
  getMessageCount(roomName: string): Promise<number>;
  clearRoomCache(roomName: string): void;
  waitForMessages(params: WaitForMessagesParams): Promise<WaitForMessagesResponse>;
}

// Implementation of the public API
export class MessagingAPI implements IMessagingAPI {
  private readonly messageService: MessageService;
  private readonly lockService: LockService;

  constructor(dataDir: string = getDataDirectory(), cacheCapacity?: number, lockService?: LockService) {
    this.lockService = lockService || new LockService(dataDir);
    this.messageService = new MessageService(dataDir, cacheCapacity, this.lockService);
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

  clearRoomCache(roomName: string): void {
    this.messageService.clearRoomCache(roomName);
  }

  async waitForMessages(params: WaitForMessagesParams): Promise<WaitForMessagesResponse> {
    return await this.messageService.waitForMessages(params);
  }
}

// Export types
export type {
  SendMessageParams,
  SendMessageResponse,
  GetMessagesParams,
  MessageListResponse,
  Message,
  WaitForMessagesParams,
  WaitForMessagesResponse
};

// Export services
export { MessageService } from './MessageService';
export { MessageStorage } from './MessageStorage';
export { MessageCache } from './MessageCache';
export { MessageValidator } from './MessageValidator';

// Export MCP tools
export { messagingTools, MessagingToolHandlers, messagingToolHandlers } from './tools/messaging.tools';

// Export default API class for instantiation
export default MessagingAPI;