import { LockService } from '../services/LockService.js';
import { RoomNotFoundError } from '../errors/index.js';
import type { IManagementAPI, SystemStatus, RoomStats } from '../features/management/index.js';
import { getDataDirectory } from '../utils/dataDir.js';

export class ManagementAdapter {
  private api?: IManagementAPI;
  private roomsAdapter?: any; // Will be injected
  private messageAdapter?: any; // Will be injected
  
  constructor(
    private readonly lockService: LockService
  ) {}
  
  setRoomsAdapter(roomsAdapter: any) {
    this.roomsAdapter = roomsAdapter;
  }
  
  setMessageAdapter(messageAdapter: any) {
    this.messageAdapter = messageAdapter;
  }
  
  async initialize(): Promise<void> {
    // Dynamic import to avoid circular dependencies
    const { ManagementAPI } = await import('../features/management/index.js');
    // Use the dataDir from lockService instead of getDataDirectory()
    const dataDir = (this.lockService as any).dataDir;
    this.api = new ManagementAPI(dataDir);
  }
  
  async getStatus(params?: { roomName?: string }): Promise<{ rooms: any[]; totalRooms: number; totalOnlineUsers: number; totalMessages: number }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // LockService is now handled in the storage layer
    const systemStatus = await this.api!.getSystemStatus();
    
    // Convert to expected format
    return {
      rooms: systemStatus.rooms.map((room: any) => ({
        name: room.name,
        onlineUsers: room.onlineUsers,
        totalMessages: room.totalMessages,
        storageSize: room.storageSize
      })),
      totalRooms: systemStatus.totalRooms,
      totalOnlineUsers: systemStatus.totalOnlineUsers,
      totalMessages: systemStatus.totalMessages
    };
  }
  
  async clearRoomMessages(params: { roomName: string; confirm: boolean }): Promise<{ success: boolean; roomName: string; clearedCount: number }> {
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
    
    // LockService is now handled in the storage layer
    const result = await this.api!.clearRoomMessages(params.roomName, params.confirm);
    
    // Clear the message cache for this room
    if (this.messageAdapter && this.messageAdapter.clearRoomCache) {
      this.messageAdapter.clearRoomCache(params.roomName);
    }
    
    return {
      success: result.success,
      roomName: result.roomName,
      clearedCount: result.clearedCount
    };
  }
}