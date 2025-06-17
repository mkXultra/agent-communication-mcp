import { promises as fs } from 'fs';
import { join } from 'path';
import { RoomScanResult, FileStats, PresenceData } from './types/management.types';

export class DataScanner {
  private dataDir: string;

  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
  }

  async scanRoomDirectory(roomName: string): Promise<RoomScanResult> {
    const messagesPath = join(this.dataDir, 'rooms', roomName, 'messages.jsonl');
    const presencePath = join(this.dataDir, 'rooms', roomName, 'presence.json');
    
    // Get file stats and message count
    const messageStats = await this.getFileStats(messagesPath);
    const messageCount = messageStats.exists ? await this.countLines(messagesPath) : 0;
    
    // Get online users count
    const onlineUsers = await this.countOnlineUsers(presencePath);
    
    return {
      messageCount,
      onlineUsers,
      storageSize: messageStats.size
    };
  }

  async getFileStats(filePath: string): Promise<FileStats> {
    try {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        exists: true
      };
    } catch (error) {
      // File doesn't exist
      return {
        size: 0,
        exists: false
      };
    }
  }

  async countLines(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (!content.trim()) {
        return 0;
      }
      return content.trim().split('\n').length;
    } catch (error) {
      return 0;
    }
  }

  async countOnlineUsers(presencePath: string): Promise<number> {
    try {
      const content = await fs.readFile(presencePath, 'utf8');
      const presence: PresenceData = JSON.parse(content);
      
      return Object.values(presence.users || {}).filter(user => user.status === 'online').length;
    } catch (error) {
      return 0;
    }
  }

  async getUsersData(presencePath: string): Promise<{[agentName: string]: { status: 'online' | 'offline' | 'away'; lastSeen?: string }}> {
    try {
      const content = await fs.readFile(presencePath, 'utf8');
      const presence: PresenceData = JSON.parse(content);
      return presence.users || {};
    } catch (error) {
      return {};
    }
  }

  async getAllRooms(): Promise<string[]> {
    try {
      const roomsPath = join(this.dataDir, 'rooms.json');
      const content = await fs.readFile(roomsPath, 'utf8');
      const rooms = JSON.parse(content);
      return Object.keys(rooms.rooms || {});
    } catch (error) {
      return [];
    }
  }

  async getRoomDirectories(): Promise<string[]> {
    try {
      const roomsDir = join(this.dataDir, 'rooms');
      const entries = await fs.readdir(roomsDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      return [];
    }
  }
}