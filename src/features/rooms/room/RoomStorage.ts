// Agent Communication MCP Server - Room Storage Implementation
// エージェントB担当：rooms.jsonファイル管理

import * as fs from 'fs/promises';
import * as path from 'path';
import { IRoomStorage, RoomsData, RoomData } from '../types/rooms.types';
import { StorageError, FileNotFoundError } from '../../../errors';
import { getDataDirectory } from '../../../utils/dataDir';

export class RoomStorage implements IRoomStorage {
  private readonly dataDir: string;
  private readonly roomsFilePath: string;

  constructor(dataDir: string = getDataDirectory()) {
    this.dataDir = dataDir;
    this.roomsFilePath = path.join(dataDir, 'rooms.json');
  }

  async readRooms(): Promise<RoomsData> {
    try {
      await this.ensureDataDirectory();
      
      try {
        const data = await fs.readFile(this.roomsFilePath, 'utf-8');
        return JSON.parse(data) as RoomsData;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // ファイルが存在しない場合は空のデータを返す
          const initialData: RoomsData = { rooms: {} };
          await this.writeRooms(initialData);
          return initialData;
        }
        throw error;
      }
    } catch (error: any) {
      throw new StorageError(`Failed to read rooms data: ${error.message}`);
    }
  }

  async writeRooms(data: RoomsData): Promise<void> {
    try {
      await this.ensureDataDirectory();
      
      const jsonData = JSON.stringify(data, null, 2);
      await fs.writeFile(this.roomsFilePath, jsonData, 'utf-8');
    } catch (error: any) {
      throw new StorageError(`Failed to write rooms data: ${error.message}`);
    }
  }

  async createRoom(roomName: string, description?: string): Promise<void> {
    try {
      const roomsData = await this.readRooms();
      
      const roomData: RoomData = {
        description,
        createdAt: new Date().toISOString(),
        messageCount: 0,
        userCount: 0
      };
      
      roomsData.rooms[roomName] = roomData;
      await this.writeRooms(roomsData);
    } catch (error: any) {
      throw new StorageError(`Failed to create room '${roomName}': ${error.message}`);
    }
  }

  async roomExists(roomName: string): Promise<boolean> {
    try {
      const roomsData = await this.readRooms();
      return roomName in roomsData.rooms;
    } catch (error: any) {
      throw new StorageError(`Failed to check room existence '${roomName}': ${error.message}`);
    }
  }

  async getRoomData(roomName: string): Promise<RoomData | null> {
    try {
      const roomsData = await this.readRooms();
      return roomsData.rooms[roomName] || null;
    } catch (error: any) {
      throw new StorageError(`Failed to get room data '${roomName}': ${error.message}`);
    }
  }

  async updateRoomUserCount(roomName: string, count: number): Promise<void> {
    try {
      const roomsData = await this.readRooms();
      
      if (!(roomName in roomsData.rooms)) {
        throw new FileNotFoundError(`Room '${roomName}' not found`);
      }
      
      const room = roomsData.rooms[roomName];
      if (room) {
        room.userCount = count;
      }
      await this.writeRooms(roomsData);
    } catch (error: any) {
      if (error instanceof FileNotFoundError) {
        throw error;
      }
      throw new StorageError(`Failed to update user count for room '${roomName}': ${error.message}`);
    }
  }

  private async ensureDataDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error: any) {
      throw new StorageError(`Failed to create data directory: ${error.message}`);
    }
  }

  // デバッグ・テスト用のメソッド
  async clearAllRooms(): Promise<void> {
    try {
      const initialData: RoomsData = { rooms: {} };
      await this.writeRooms(initialData);
    } catch (error: any) {
      throw new StorageError(`Failed to clear all rooms: ${error.message}`);
    }
  }

  async getAllRoomNames(): Promise<string[]> {
    try {
      const roomsData = await this.readRooms();
      return Object.keys(roomsData.rooms);
    } catch (error: any) {
      throw new StorageError(`Failed to get room names: ${error.message}`);
    }
  }
}