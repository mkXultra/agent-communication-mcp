import { promises as fs } from 'fs';
import { join } from 'path';
import { StatsCollector } from './StatsCollector';
import { SystemStatus, RoomStats, ClearResult } from './types/management.types';
import { 
  RoomNotFoundError, 
  ValidationError, 
  StorageError,
  ConfirmationRequiredError
} from '../../errors/AppError';
import { getDataDirectory } from '../../utils/dataDir';

export class ManagementService {
  private statsCollector: StatsCollector;
  private dataDir: string;

  constructor(dataDir: string = getDataDirectory()) {
    this.dataDir = dataDir;
    this.statsCollector = new StatsCollector(dataDir);
  }

  async getStatus(roomName?: string): Promise<SystemStatus> {
    try {
      if (roomName) {
        await this.validateRoomExists(roomName);
      }
      
      return await this.statsCollector.collectSystemStatus(roomName);
    } catch (error) {
      if (error instanceof RoomNotFoundError) {
        throw error;
      }
      throw new StorageError('Failed to get status', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async getSystemStatus(): Promise<SystemStatus> {
    return this.getStatus();
  }

  async getRoomStatistics(roomName: string): Promise<RoomStats> {
    try {
      await this.validateRoomExists(roomName);
      return await this.statsCollector.getRoomStatistics(roomName);
    } catch (error) {
      if (error instanceof RoomNotFoundError) {
        throw error;
      }
      throw new StorageError('Failed to get room statistics', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async clearRoomMessages(roomName: string, confirm: boolean): Promise<ClearResult> {
    if (!confirm) {
      throw new ConfirmationRequiredError('clearing room messages');
    }

    try {
      await this.validateRoomExists(roomName);
      
      const messagesPath = join(this.dataDir, 'rooms', roomName, 'messages.jsonl');
      let clearedCount = 0;
      
      // Count messages before deletion
      try {
        const content = await fs.readFile(messagesPath, 'utf8');
        if (content.trim()) {
          clearedCount = content.trim().split('\n').length;
        }
      } catch (error) {
        // File doesn't exist, clearedCount remains 0
      }
      
      // Clear messages file (write empty content instead of deleting)
      try {
        await fs.writeFile(messagesPath, '');
      } catch (error) {
        // Try to create the file if it doesn't exist
        try {
          await fs.mkdir(join(this.dataDir, 'rooms', roomName), { recursive: true });
          await fs.writeFile(messagesPath, '');
        } catch (createError) {
          throw new StorageError('Failed to clear messages file', createError instanceof Error ? createError.message : 'Unknown error');
        }
      }
      
      // Update room registry to reset message count
      await this.resetRoomMessageCount(roomName);
      
      return {
        success: true,
        roomName,
        clearedCount
      };
    } catch (error) {
      if (error instanceof RoomNotFoundError || error instanceof ValidationError || error instanceof ConfirmationRequiredError) {
        throw error;
      }
      throw new StorageError('Failed to clear room messages', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private async validateRoomExists(roomName: string): Promise<void> {
    const roomsPath = join(this.dataDir, 'rooms.json');
    
    try {
      const content = await fs.readFile(roomsPath, 'utf8');
      const rooms = JSON.parse(content);
      
      if (!rooms.rooms || !rooms.rooms[roomName]) {
        throw new RoomNotFoundError(roomName);
      }
    } catch (error) {
      if (error instanceof RoomNotFoundError) {
        throw error;
      }
      throw new RoomNotFoundError(roomName);
    }
  }

  private async resetRoomMessageCount(roomName: string): Promise<void> {
    const roomsPath = join(this.dataDir, 'rooms.json');
    
    try {
      const content = await fs.readFile(roomsPath, 'utf8');
      const rooms = JSON.parse(content);
      
      if (rooms.rooms && rooms.rooms[roomName]) {
        rooms.rooms[roomName].messageCount = 0;
        
        await fs.writeFile(roomsPath, JSON.stringify(rooms, null, 2));
      }
    } catch (error) {
      // If we can't update the room stats, it's not critical
      // The actual message file has been cleared
    }
  }

  async getSystemMetrics(): Promise<{
    totalStorageSize: number;
    mostActiveRoom: RoomStats | null;
  }> {
    try {
      const totalStorageSize = await this.statsCollector.getTotalStorageSize();
      const mostActiveRoom = await this.statsCollector.getMostActiveRoom();
      
      return {
        totalStorageSize,
        mostActiveRoom
      };
    } catch (error) {
      throw new StorageError('Failed to get system metrics', error instanceof Error ? error.message : 'Unknown error');
    }
  }
}