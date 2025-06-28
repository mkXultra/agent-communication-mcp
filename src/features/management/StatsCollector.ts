import { join } from 'path';
import { DataScanner } from './DataScanner';
import { RoomStats, SystemStatus } from './types/management.types';
import { getDataDirectory } from '../../utils/dataDir';

export class StatsCollector {
  private scanner: DataScanner;
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || getDataDirectory();
    this.scanner = new DataScanner(this.dataDir);
  }

  async collectSystemStatus(specificRoom?: string): Promise<SystemStatus> {
    if (specificRoom) {
      return this.collectRoomSpecificStatus(specificRoom);
    }

    const rooms = await this.scanner.getAllRooms();
    const roomStats: RoomStats[] = [];
    const uniqueOnlineUsers = new Set<string>();
    
    let totalMessages = 0;
    let totalStorageSize = 0;

    for (const roomName of rooms) {
      const scanResult = await this.scanner.scanRoomDirectory(roomName);
      
      // Get the actual user data to track unique users
      const presencePath = join(this.dataDir, 'rooms', roomName, 'presence.json');
      const usersData = await this.scanner.getUsersData(presencePath);
      
      // Add online users to the unique set
      Object.entries(usersData).forEach(([agentName, userData]) => {
        if (userData.status === 'online') {
          uniqueOnlineUsers.add(agentName);
        }
      });
      
      const roomStat: RoomStats = {
        name: roomName,
        onlineUsers: scanResult.onlineUsers,
        totalMessages: scanResult.messageCount,
        storageSize: scanResult.storageSize
      };
      
      roomStats.push(roomStat);
      totalMessages += scanResult.messageCount;
      totalStorageSize += scanResult.storageSize;
    }

    return {
      rooms: roomStats,
      totalRooms: rooms.length,
      totalOnlineUsers: uniqueOnlineUsers.size,
      totalMessages,
      totalStorageSize
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
      totalMessages: scanResult.messageCount,
      totalStorageSize: scanResult.storageSize
    };
  }

  async getRoomStatistics(roomName: string): Promise<RoomStats> {
    const scanResult = await this.scanner.scanRoomDirectory(roomName);
    const presencePath = join(this.dataDir, 'rooms', roomName, 'presence.json');
    const users = await this.scanner.getUsersData(presencePath);
    
    return {
      name: roomName,
      onlineUsers: scanResult.onlineUsers,
      totalMessages: scanResult.messageCount,
      storageSize: scanResult.storageSize,
      users: Object.keys(users).length > 0 ? users : undefined
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