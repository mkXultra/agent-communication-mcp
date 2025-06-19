import { MessageStorage } from './MessageStorage';
import { MessageValidator } from './MessageValidator';
import { MessageCache } from './MessageCache';
import { generateUUID } from './utils';
import { getDataDirectory } from '../../utils/dataDir';
import {
  SendMessageParams,
  SendMessageResponse,
  GetMessagesParams,
  MessageListResponse,
  MessageStorageData
} from './types/messaging.types';

export class MessageService {
  private readonly storage: MessageStorage;
  private readonly cache: MessageCache;

  constructor(dataDir?: string, cacheCapacity?: number) {
    this.storage = new MessageStorage(dataDir || getDataDirectory());
    this.cache = new MessageCache(cacheCapacity);
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    // Validate input parameters
    const validatedParams = MessageValidator.validateSendMessage(params);
    
    // Room existence check is handled by MessagingAdapter
    
    // Generate message ID and timestamp
    const messageId = generateUUID();
    const timestamp = new Date().toISOString();
    
    // Extract mentions from message
    const mentions = MessageValidator.extractMentions(validatedParams.message);
    
    // Create message data for storage
    const messageData: MessageStorageData = {
      id: messageId,
      agentName: validatedParams.agentName,
      message: validatedParams.message,
      timestamp,
      mentions,
      metadata: validatedParams.metadata
    };
    
    // Save message to storage
    await this.storage.saveMessage(validatedParams.roomName, messageData);
    
    // Clear cache for this room since new message was added
    this.cache.clear(validatedParams.roomName);
    
    // Return response
    return {
      success: true,
      messageId,
      roomName: validatedParams.roomName,
      timestamp,
      mentions
    };
  }

  async getMessages(params: GetMessagesParams): Promise<MessageListResponse> {
    // Validate input parameters
    const validatedParams = MessageValidator.validateGetMessages(params);
    
    // Room existence check is handled by MessagingAdapter
    
    // Check cache first
    const cachedResult = this.cache.get(validatedParams);
    if (cachedResult) {
      return cachedResult;
    }
    
    // Get messages from storage
    const result = await this.storage.getMessages(validatedParams);
    
    // Prepare response
    const response: MessageListResponse = {
      roomName: validatedParams.roomName,
      messages: result.messages,
      count: result.messages.length,
      hasMore: result.hasMore
    };
    
    // Cache the result
    this.cache.set(validatedParams, response);
    
    return response;
  }

  async getMessageCount(roomName: string): Promise<number> {
    // Validate room name
    MessageValidator.validateGetMessages({ roomName });
    
    // Room existence check is handled by caller
    
    return await this.storage.getMessageCount(roomName);
  }
}