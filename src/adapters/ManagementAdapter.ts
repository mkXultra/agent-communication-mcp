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
    const dataDir = getDataDirectory();
    this.api = new ManagementAPI(dataDir);
  }
  
  async getStatus(params?: { roomName?: string }): Promise<{ rooms: any[]; totalRooms: number; totalOnlineUsers: number; totalMessages: number }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // Get status with distributed locking to ensure consistency
    return await this.lockService.withLock(
      'system-status',
      async () => {
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
    );
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
    
    // Clear messages with file locking
    return await this.lockService.withLock(
      `rooms/${params.roomName}/messages.jsonl`,
      async () => {
        const result = await this.api!.clearRoomMessages(params.roomName, params.confirm);
        return {
          success: result.success,
          roomName: result.roomName,
          clearedCount: result.clearedCount
        };
      }
    );
  }
}