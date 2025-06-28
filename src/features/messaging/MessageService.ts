import { MessageStorage } from './MessageStorage';
import { MessageValidator } from './MessageValidator';
import { MessageCache } from './MessageCache';
import { generateUUID } from './utils';
import { getDataDirectory } from '../../utils/dataDir';
import { LockService } from '../../services/LockService';
import {
  SendMessageParams,
  SendMessageResponse,
  GetMessagesParams,
  MessageListResponse,
  MessageStorageData,
  WaitForMessagesParams,
  WaitForMessagesResponse,
  WaitingAgentInfo,
  ReadStatusInfo,
  Message
} from './types/messaging.types';
import { WAIT_CONSTANTS, READ_STATUS_FILENAME, WAITING_AGENTS_FILENAME } from './constants';
import { RoomNotFoundError, AgentNotInRoomError } from '../../errors/AppError';
import * as fs from 'fs/promises';
import * as path from 'path';

export class MessageService {
  private readonly storage: MessageStorage;
  private readonly cache: MessageCache;
  private readonly lockService: LockService;

  constructor(dataDir: string = getDataDirectory(), cacheCapacity?: number, lockService?: LockService) {
    this.lockService = lockService || new LockService(dataDir);
    this.storage = new MessageStorage(dataDir, this.lockService);
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

  clearRoomCache(roomName: string): void {
    this.cache.clear(roomName);
  }

  async waitForMessages(params: WaitForMessagesParams): Promise<WaitForMessagesResponse> {
    // Validate input parameters
    const validatedParams = MessageValidator.validateWaitForMessages(params);
    
    // Note: Room existence and agent membership checks should be done by the adapter layer
    // The MessageService itself doesn't have access to room data
    
    const timeout = validatedParams.timeout || WAIT_CONSTANTS.DEFAULT_TIMEOUT;
    const startTime = Date.now();
    let pollInterval = WAIT_CONSTANTS.INITIAL_POLL_INTERVAL;
    
    // Add agent to waiting list
    await this.addWaitingAgent(validatedParams.roomName, validatedParams.agentName, timeout);
    
    // Send system message about waiting
    await this.sendSystemMessage(
      validatedParams.roomName,
      `${validatedParams.agentName} is waiting for new messages (timeout: ${timeout}ms)`
    );
    
    // Check for deadlock
    const waitingAgents = await this.getWaitingAgents(validatedParams.roomName);
    const otherWaitingAgents = waitingAgents
      .filter(agent => agent.agentName !== validatedParams.agentName)
      .map(agent => agent.agentName);
    
    let warning: string | undefined;
    if (otherWaitingAgents.length >= 1) {
      warning = `Potential deadlock detected: ${otherWaitingAgents.length} other agent(s) are also waiting for messages`;
    }
    
    try {
      // Poll for new messages
      while (Date.now() - startTime < timeout) {
        // Get unread messages
        const unreadMessages = await this.getUnreadMessages(
          validatedParams.roomName,
          validatedParams.agentName
        );
        
        if (unreadMessages.length > 0) {
          // Update read status
          const lastMessage = unreadMessages[unreadMessages.length - 1]!; // Safe because we checked length > 0
          await this.updateReadStatus(
            validatedParams.roomName,
            validatedParams.agentName,
            lastMessage
          );
          
          // Remove from waiting list
          await this.removeWaitingAgent(validatedParams.roomName, validatedParams.agentName);
          
          return {
            messages: unreadMessages,
            hasNewMessages: true,
            timedOut: false,
            warning,
            waitingAgents: otherWaitingAgents.length > 0 ? otherWaitingAgents : undefined
          };
        }
        
        // Wait before next poll with exponential backoff
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        pollInterval = Math.min(pollInterval * WAIT_CONSTANTS.BACKOFF_FACTOR, WAIT_CONSTANTS.MAX_POLL_INTERVAL);
      }
      
      // Timeout reached
      await this.removeWaitingAgent(validatedParams.roomName, validatedParams.agentName);
      
      // Send system message about timeout
      await this.sendSystemMessage(
        validatedParams.roomName,
        `${validatedParams.agentName} stopped waiting (timeout reached)`
      );
      
      return {
        messages: [],
        hasNewMessages: false,
        timedOut: true,
        warning,
        waitingAgents: otherWaitingAgents.length > 0 ? otherWaitingAgents : undefined
      };
    } catch (error) {
      // Clean up on error
      try {
        await this.removeWaitingAgent(validatedParams.roomName, validatedParams.agentName);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private async getUnreadMessages(roomName: string, agentName: string): Promise<Message[]> {
    // Get last read status
    const readStatus = await this.getReadStatus(roomName, agentName);
    
    // Get all messages
    const allMessages = await this.storage.getAllMessages(roomName);
    
    // Filter unread messages (excluding agent's own messages)
    let unreadMessages: Message[] = [];
    
    if (readStatus) {
      const lastReadIndex = allMessages.findIndex(msg => msg.id === readStatus.lastReadMessageId);
      if (lastReadIndex >= 0) {
        unreadMessages = allMessages.slice(lastReadIndex + 1);
      } else {
        // If last read message not found, consider all messages as unread
        unreadMessages = allMessages;
      }
    } else {
      // No read status, all messages are unread
      unreadMessages = allMessages;
    }
    
    // Filter out agent's own messages and system messages
    return unreadMessages.filter(msg => msg.agentName !== agentName && msg.agentName !== 'system');
  }

  private async getReadStatus(roomName: string, agentName: string): Promise<ReadStatusInfo | null> {
    const readStatusPath = path.join(this.storage.dataDirectory, 'rooms', roomName, READ_STATUS_FILENAME);
    
    try {
      const data = await fs.readFile(readStatusPath, 'utf-8');
      const readStatuses = JSON.parse(data);
      return readStatuses[agentName] || null;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      // For corrupted files, return null to treat as no read status
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  private async updateReadStatus(roomName: string, agentName: string, lastMessage: Message): Promise<void> {
    const roomDir = path.join(this.storage.dataDirectory, 'rooms', roomName);
    const readStatusPath = path.join(roomDir, READ_STATUS_FILENAME);
    
    await this.lockService.withLock(`read-status-${roomName}`, async () => {
      // Ensure room directory exists
      try {
        await fs.access(roomDir);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // If room doesn't exist, skip updating read status
          return;
        }
        throw error;
      }

      let readStatuses: Record<string, ReadStatusInfo> = {};
      
      try {
        const data = await fs.readFile(readStatusPath, 'utf-8');
        readStatuses = JSON.parse(data);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          // Ignore corrupted files, start fresh
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
        }
      }
      
      readStatuses[agentName] = {
        agentName,
        lastReadMessageId: lastMessage.id,
        lastReadTimestamp: new Date().toISOString()
      };
      
      await fs.writeFile(readStatusPath, JSON.stringify(readStatuses, null, 2));
    });
  }

  private async addWaitingAgent(roomName: string, agentName: string, timeout: number): Promise<void> {
    const roomDir = path.join(this.storage.dataDirectory, 'rooms', roomName);
    const waitingAgentsPath = path.join(roomDir, WAITING_AGENTS_FILENAME);
    
    await this.lockService.withLock(`waiting-agents-${roomName}`, async () => {
      // Ensure room directory exists
      try {
        await fs.access(roomDir);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          throw new RoomNotFoundError(roomName);
        }
        throw error;
      }

      let waitingAgents: WaitingAgentInfo[] = [];
      
      try {
        const data = await fs.readFile(waitingAgentsPath, 'utf-8');
        waitingAgents = JSON.parse(data);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      
      // Remove any existing entry for this agent
      waitingAgents = waitingAgents.filter(agent => agent.agentName !== agentName);
      
      // Add new entry
      waitingAgents.push({
        agentName,
        startTime: new Date().toISOString(),
        timeout
      });
      
      await fs.writeFile(waitingAgentsPath, JSON.stringify(waitingAgents, null, 2));
    });
  }

  private async removeWaitingAgent(roomName: string, agentName: string): Promise<void> {
    const waitingAgentsPath = path.join(this.storage.dataDirectory, 'rooms', roomName, WAITING_AGENTS_FILENAME);
    
    await this.lockService.withLock(`waiting-agents-${roomName}`, async () => {
      let waitingAgents: WaitingAgentInfo[] = [];
      
      try {
        const data = await fs.readFile(waitingAgentsPath, 'utf-8');
        waitingAgents = JSON.parse(data);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      
      // Remove agent from list
      waitingAgents = waitingAgents.filter(agent => agent.agentName !== agentName);
      
      await fs.writeFile(waitingAgentsPath, JSON.stringify(waitingAgents, null, 2));
    });
  }

  private async getWaitingAgents(roomName: string): Promise<WaitingAgentInfo[]> {
    const waitingAgentsPath = path.join(this.storage.dataDirectory, 'rooms', roomName, WAITING_AGENTS_FILENAME);
    
    try {
      const data = await fs.readFile(waitingAgentsPath, 'utf-8');
      return JSON.parse(data);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async sendSystemMessage(roomName: string, message: string): Promise<void> {
    const messageData: MessageStorageData = {
      id: generateUUID(),
      agentName: 'system',
      message,
      timestamp: new Date().toISOString(),
      mentions: [],
      metadata: { type: 'system' }
    };
    
    await this.storage.saveMessage(roomName, messageData);
  }
}