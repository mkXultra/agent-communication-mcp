import { LockService } from '../services/LockService.js';
import { RoomNotFoundError, AgentNotInRoomError } from '../errors/index.js';
import { Message } from '../types/index.js';
import type { IMessagingAPI } from '../features/messaging/index.js';

export class MessagingAdapter {
  private api?: IMessagingAPI;
  private roomsAdapter?: any; // Will be injected
  
  constructor(
    private readonly lockService: LockService
  ) {}
  
  setRoomsAdapter(roomsAdapter: any) {
    this.roomsAdapter = roomsAdapter;
  }
  
  async initialize(): Promise<void> {
    // Dynamic import to avoid circular dependencies
    const { MessagingAPI } = await import('../features/messaging/index.js');
    const dataDir = process.env.AGENT_COMM_DATA_DIR || './data';
    this.api = new MessagingAPI(dataDir);
  }
  
  async sendMessage(params: { agentName: string; roomName: string; message: string; metadata?: any }): Promise<{ success: boolean; messageId: string; timestamp: string; roomName: string; mentions: string[] }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // Check if room exists
    if (!this.roomsAdapter) {
      throw new Error('RoomsAdapter not initialized');
    }
    
    const roomExists = await this.roomsAdapter.roomExists(params.roomName);
    if (!roomExists) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    // Check if agent is in room
    const roomUsers = await this.roomsAdapter.getRoomUsers(params.roomName);
    if (!roomUsers.includes(params.agentName)) {
      throw new AgentNotInRoomError(params.agentName, params.roomName);
    }
    
    // Send message with file locking
    return await this.lockService.withLock(
      `rooms/${params.roomName}/messages.jsonl`,
      async () => {
        const result = await this.api!.sendMessage(params);
        return {
          success: result.success,
          messageId: result.messageId,
          timestamp: result.timestamp,
          roomName: result.roomName,
          mentions: result.mentions
        };
      }
    );
  }
  
  async getMessages(params: { agentName?: string; roomName: string; limit?: number; offset?: number; mentionsOnly?: boolean }): Promise<{ roomName: string; messages: Message[]; count: number; hasMore: boolean }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // Check if room exists
    if (!this.roomsAdapter) {
      throw new Error('RoomsAdapter not initialized');
    }
    
    const roomExists = await this.roomsAdapter.roomExists(params.roomName);
    if (!roomExists) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    // Check if agent is in room (only if agentName provided)
    if (params.agentName) {
      const roomUsers = await this.roomsAdapter.getRoomUsers(params.roomName);
      if (!roomUsers.includes(params.agentName)) {
        throw new AgentNotInRoomError(params.agentName, params.roomName);
      }
    }
    
    // Get messages with file locking
    return await this.lockService.withLock(
      `rooms/${params.roomName}/messages.jsonl`,
      async () => {
        const result = await this.api!.getMessages(params);
        return {
          roomName: params.roomName,
          messages: result.messages,
          count: result.messages.length,
          hasMore: result.hasMore
        };
      }
    );
  }
}