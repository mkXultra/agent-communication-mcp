import { DataScanner } from './DataScanner';
import { RoomStats, SystemStatus } from './types/management.types';

export class StatsCollector {
  private scanner: DataScanner;

  constructor(dataDir?: string) {
    this.scanner = new DataScanner(dataDir);
  }

  async collectSystemStatus(specificRoom?: string): Promise<SystemStatus> {
    if (specificRoom) {
      return this.collectRoomSpecificStatus(specificRoom);
    }

    const rooms = await this.scanner.getAllRooms();
    const roomStats: RoomStats[] = [];
    
    let totalOnlineUsers = 0;
    let totalMessages = 0;

    for (const roomName of rooms) {
      const scanResult = await this.scanner.scanRoomDirectory(roomName);
      
      const roomStat: RoomStats = {
        name: roomName,
        onlineUsers: scanResult.onlineUsers,
        totalMessages: scanResult.messageCount,
        storageSize: scanResult.storageSize
      };
      
      roomStats.push(roomStat);
      totalOnlineUsers += scanResult.onlineUsers;
      totalMessages += scanResult.messageCount;
    }

    return {
      rooms: roomStats,
      totalRooms: rooms.length,
      totalOnlineUsers,
      totalMessages
    };
  }

  private async collectRoomSpecificStatus(roomName: string): Promise<SystemStatus> {
    const scanResult = await this.scanner.scanRoomDirectory(roomName);
    
    const roomStat: RoomStats = {
      name: roomName,
      onlineUsers: scanResult.onlineUsers,
      totalMessages: scanResult.messageCount,
      storageSize: scanResult.storageSize
    };

    return {
      rooms: [roomStat],
      totalRooms: 1,
      totalOnlineUsers: scanResult.onlineUsers,
      totalMessages: scanResult.messageCount
    };
  }

  async getRoomStatistics(roomName: string): Promise<RoomStats> {
    const scanResult = await this.scanner.scanRoomDirectory(roomName);
    
    return {
      name: roomName,
      onlineUsers: scanResult.onlineUsers,
      totalMessages: scanResult.messageCount,
      storageSize: scanResult.storageSize
    };
  }

  async getTotalStorageSize(): Promise<number> {
    const rooms = await this.scanner.getAllRooms();
    let totalSize = 0;

    for (const roomName of rooms) {
      const scanResult = await this.scanner.scanRoomDirectory(roomName);
      totalSize += scanResult.storageSize;
    }

    return totalSize;
  }

  async getMostActiveRoom(): Promise<RoomStats | null> {
    const status = await this.collectSystemStatus();
    
    if (status.rooms.length === 0) {
      return null;
    }

    return status.rooms.reduce((most, current) => 
      current.totalMessages > most.totalMessages ? current : most
    );
  }
}