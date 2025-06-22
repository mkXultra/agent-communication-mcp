import { LockService } from '../services/LockService.js';
import { RoomNotFoundError, RoomAlreadyExistsError, AgentNotInRoomError } from '../errors/index.js';
import { Room } from '../types/index.js';
import type { IRoomsAPI } from '../features/rooms/index.js';
import { getDataDirectory } from '../utils/dataDir.js';

export class RoomsAdapter {
  private api?: IRoomsAPI;
  private messageAdapter?: any; // Will be injected to get message counts
  
  constructor(
    private readonly lockService: LockService
  ) {}
  
  setMessageAdapter(messageAdapter: any) {
    this.messageAdapter = messageAdapter;
  }
  
  async initialize(): Promise<void> {
    // Dynamic import to avoid circular dependencies
    const { RoomsAPI } = await import('../features/rooms/index.js');
    // Use the dataDir from lockService instead of getDataDirectory()
    const dataDir = (this.lockService as any).dataDir;
    this.api = new RoomsAPI(dataDir);
  }
  
  async listRooms(agentName?: string): Promise<{ rooms: Room[] }> {
    if (!this.api) {
      await this.initialize();
    }
    
    return await this.lockService.withLock(
      'rooms.json',
      async () => {
        const result = await this.api!.listRooms(agentName);
        // Convert RoomListItem[] to Room[]
        const rooms: Room[] = result.rooms.map(item => ({
          name: item.name,
          description: item.description,
          createdAt: new Date().toISOString(), // Since RoomListItem doesn't have createdAt
          messageCount: item.messageCount,
          userCount: item.userCount
        }));
        return { rooms };
      }
    );
  }
  
  async createRoom(params: { roomName: string; description?: string }): Promise<{ success: boolean; roomName: string }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // Check if room already exists
    const exists = await this.roomExists(params.roomName);
    if (exists) {
      throw new RoomAlreadyExistsError(params.roomName);
    }
    
    return await this.lockService.withLock(
      'rooms.json',
      async () => {
        const result = await this.api!.createRoom(params.roomName, params.description);
        return { success: result.success, roomName: result.roomName };
      }
    );
  }
  
  async enterRoom(params: { agentName: string; roomName: string; profile?: any }): Promise<{ success: boolean }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // Check if room exists
    const exists = await this.roomExists(params.roomName);
    if (!exists) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    return await this.lockService.withLock(
      `rooms/${params.roomName}/presence.json`,
      async () => {
        const result = await this.api!.enterRoom(params.agentName, params.roomName, params.profile);
        return { success: result.success };
      }
    );
  }
  
  async leaveRoom(params: { agentName: string; roomName: string }): Promise<{ success: boolean }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // Check if room exists
    const exists = await this.roomExists(params.roomName);
    if (!exists) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    // Check if agent is in room
    const isInRoom = await this.api!.isUserInRoom(params.roomName, params.agentName);
    if (!isInRoom) {
      throw new AgentNotInRoomError(params.agentName, params.roomName);
    }
    
    return await this.lockService.withLock(
      `rooms/${params.roomName}/presence.json`,
      async () => {
        const result = await this.api!.leaveRoom(params.agentName, params.roomName);
        return { success: result.success };
      }
    );
  }
  
  async listRoomUsers(params: { roomName: string }): Promise<{ roomName: string; users: any[]; onlineCount: number }> {
    if (!this.api) {
      await this.initialize();
    }
    
    // Check if room exists
    const exists = await this.roomExists(params.roomName);
    if (!exists) {
      throw new RoomNotFoundError(params.roomName);
    }
    
    return await this.lockService.withLock(
      `rooms/${params.roomName}/presence.json`,
      async () => {
        const result = await this.api!.getRoomUsers(params.roomName);
        return result;
      }
    );
  }
  
  async roomExists(roomName: string): Promise<boolean> {
    if (!this.api) {
      await this.initialize();
    }
    
    return this.api!.roomExists(roomName);
  }
  
  async getRoomUsers(roomName: string): Promise<string[]> {
    if (!this.api) {
      await this.initialize();
    }
    
    const result = await this.api!.getRoomUsers(roomName);
    return result.users.map((user: any) => user.name);
  }
}