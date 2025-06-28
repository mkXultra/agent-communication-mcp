// Agent Communication MCP Server - Presence Storage Implementation
// エージェントB担当：presence.jsonファイル管理

import * as fs from 'fs/promises';
import * as path from 'path';
import { IPresenceStorage, PresenceData, PresenceUser } from '../types/rooms.types';
import { AgentProfile } from '../../../types/entities';
import { StorageError, FileNotFoundError } from '../../../errors';
import { getDataDirectory } from '../../../utils/dataDir';
import { LockService } from '../../../services/LockService';

export class PresenceStorage implements IPresenceStorage {
  private readonly dataDir: string;
  private readonly lockService: LockService;

  constructor(dataDir: string = getDataDirectory(), lockService?: LockService) {
    this.dataDir = dataDir;
    this.lockService = lockService || new LockService(dataDir);
  }

  async readPresence(roomName: string): Promise<PresenceData> {
    try {
      await this.ensureRoomDirectory(roomName);
      
      const presenceFilePath = this.getPresenceFilePath(roomName);
      
      try {
        const data = await fs.readFile(presenceFilePath, 'utf-8');
        return JSON.parse(data) as PresenceData;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // ファイルが存在しない場合は空のデータを返す
          const initialData: PresenceData = {
            roomName,
            users: {}
          };
          await this.writePresence(roomName, initialData);
          return initialData;
        }
        throw error;
      }
    } catch (error: any) {
      throw new StorageError(`Failed to read presence data for room '${roomName}': ${error.message}`);
    }
  }

  async writePresence(roomName: string, data: PresenceData): Promise<void> {
    try {
      await this.ensureRoomDirectory(roomName);
      
      const presenceFilePath = this.getPresenceFilePath(roomName);
      const jsonData = JSON.stringify(data, null, 2);
      await fs.writeFile(presenceFilePath, jsonData, 'utf-8');
    } catch (error: any) {
      throw new StorageError(`Failed to write presence data for room '${roomName}': ${error.message}`);
    }
  }

  async addUser(roomName: string, agentName: string, profile?: AgentProfile): Promise<void> {
    try {
      await this.lockService.withLock(`rooms/${roomName}/presence.json`, async () => {
        const presenceData = await this.readPresence(roomName);
        
        // Check if user already exists
        const existingUser = presenceData.users[agentName];
        
        const userData: PresenceUser = {
          status: 'online',
          messageCount: existingUser?.messageCount || 0,
          joinedAt: existingUser?.joinedAt || new Date().toISOString(),
          profile
        };
        
        presenceData.users[agentName] = userData;
        await this.writePresence(roomName, presenceData);
      });
    } catch (error: any) {
      throw new StorageError(`Failed to add user '${agentName}' to room '${roomName}': ${error.message}`);
    }
  }

  async removeUser(roomName: string, agentName: string): Promise<void> {
    try {
      await this.lockService.withLock(`rooms/${roomName}/presence.json`, async () => {
        const presenceData = await this.readPresence(roomName);
        
        if (!(agentName in presenceData.users)) {
          throw new FileNotFoundError(`User '${agentName}' not found in room '${roomName}'`);
        }
        
        delete presenceData.users[agentName];
        await this.writePresence(roomName, presenceData);
      });
    } catch (error: any) {
      if (error instanceof FileNotFoundError) {
        throw error;
      }
      throw new StorageError(`Failed to remove user '${agentName}' from room '${roomName}': ${error.message}`);
    }
  }

  async updateUserStatus(roomName: string, agentName: string, status: 'online' | 'offline'): Promise<void> {
    try {
      await this.lockService.withLock(`rooms/${roomName}/presence.json`, async () => {
        const presenceData = await this.readPresence(roomName);
        
        if (!(agentName in presenceData.users)) {
          throw new FileNotFoundError(`User '${agentName}' not found in room '${roomName}'`);
        }
        
        const user = presenceData.users[agentName];
        if (user) {
          user.status = status;
        }
        await this.writePresence(roomName, presenceData);
      });
    } catch (error: any) {
      if (error instanceof FileNotFoundError) {
        throw error;
      }
      throw new StorageError(`Failed to update status for user '${agentName}' in room '${roomName}': ${error.message}`);
    }
  }

  async getUsersInRoom(roomName: string): Promise<PresenceUser[]> {
    try {
      const presenceData = await this.readPresence(roomName);
      return Object.values(presenceData.users);
    } catch (error: any) {
      throw new StorageError(`Failed to get users in room '${roomName}': ${error.message}`);
    }
  }

  async isUserInRoom(roomName: string, agentName: string): Promise<boolean> {
    try {
      const presenceData = await this.readPresence(roomName);
      return agentName in presenceData.users;
    } catch (error: any) {
      throw new StorageError(`Failed to check if user '${agentName}' is in room '${roomName}': ${error.message}`);
    }
  }

  // ユーティリティメソッド
  async getUserStatus(roomName: string, agentName: string): Promise<'online' | 'offline' | null> {
    try {
      const presenceData = await this.readPresence(roomName);
      const user = presenceData.users[agentName];
      return user ? user.status : null;
    } catch (error: any) {
      throw new StorageError(`Failed to get status for user '${agentName}' in room '${roomName}': ${error.message}`);
    }
  }

  async getOnlineUsersCount(roomName: string): Promise<number> {
    try {
      const presenceData = await this.readPresence(roomName);
      return Object.values(presenceData.users).filter(user => user.status === 'online').length;
    } catch (error: any) {
      throw new StorageError(`Failed to get online users count in room '${roomName}': ${error.message}`);
    }
  }

  async incrementUserMessageCount(roomName: string, agentName: string): Promise<void> {
    try {
      await this.lockService.withLock(`rooms/${roomName}/presence.json`, async () => {
        const presenceData = await this.readPresence(roomName);
        
        if (!(agentName in presenceData.users)) {
          throw new FileNotFoundError(`User '${agentName}' not found in room '${roomName}'`);
        }
        
        const user = presenceData.users[agentName];
        if (user && user.messageCount !== undefined) {
          user.messageCount++;
        }
        await this.writePresence(roomName, presenceData);
      });
    } catch (error: any) {
      if (error instanceof FileNotFoundError) {
        throw error;
      }
      throw new StorageError(`Failed to increment message count for user '${agentName}' in room '${roomName}': ${error.message}`);
    }
  }

  private getPresenceFilePath(roomName: string): string {
    return path.join(this.dataDir, 'rooms', roomName, 'presence.json');
  }

  private async ensureRoomDirectory(roomName: string): Promise<void> {
    try {
      const roomDir = path.join(this.dataDir, 'rooms', roomName);
      await fs.mkdir(roomDir, { recursive: true });
    } catch (error: any) {
      throw new StorageError(`Failed to create room directory for '${roomName}': ${error.message}`);
    }
  }

  // デバッグ・テスト用のメソッド
  async clearRoomPresence(roomName: string): Promise<void> {
    try {
      await this.lockService.withLock(`rooms/${roomName}/presence.json`, async () => {
        const initialData: PresenceData = {
          roomName,
          users: {}
        };
        await this.writePresence(roomName, initialData);
      });
    } catch (error: any) {
      throw new StorageError(`Failed to clear presence for room '${roomName}': ${error.message}`);
    }
  }

  async getAllUsersInRoom(roomName: string): Promise<Record<string, PresenceUser>> {
    try {
      const presenceData = await this.readPresence(roomName);
      return presenceData.users;
    } catch (error: any) {
      throw new StorageError(`Failed to get all users in room '${roomName}': ${error.message}`);
    }
  }

}