// Agent Communication MCP Server - Management Feature Public API

import type { SystemStatus, RoomStats, ClearResult } from './types/management.types';
import { ManagementService } from './ManagementService';

export { ManagementService } from './ManagementService';
export { DataScanner } from './DataScanner';
export { StatsCollector } from './StatsCollector';

// Export schemas
export { 
  getStatusInputSchema as getStatusSchema, 
  clearRoomMessagesInputSchema as clearRoomMessagesSchema,
  GetStatusInput as GetStatusParams,
  ClearRoomMessagesInput as ClearRoomMessagesParams 
} from '../../schemas/management.schema';

// Export types
export type {
  RoomStats,
  SystemStatus,
  ClearResult,
  RoomScanResult,
  FileStats,
  PresenceData
} from './types/management.types';

// Export Management API interface
export interface IManagementAPI {
  getSystemStatus(): Promise<SystemStatus>;
  getRoomStatistics(roomName: string): Promise<RoomStats>;
  clearRoomMessages(roomName: string, confirm: boolean): Promise<ClearResult>;
  getSystemMetrics(): Promise<{
    totalStorageSize: number;
    mostActiveRoom: RoomStats | null;
  }>;
}

// Implementation of the Management API
export class ManagementAPI implements IManagementAPI {
  private service: ManagementService;

  constructor(dataDir?: string) {
    this.service = new ManagementService(dataDir);
  }

  async getSystemStatus(): Promise<SystemStatus> {
    return await this.service.getStatus();
  }

  async getRoomStatistics(roomName: string): Promise<RoomStats> {
    return await this.service.getRoomStatistics(roomName);
  }

  async clearRoomMessages(roomName: string, confirm: boolean): Promise<ClearResult> {
    return await this.service.clearRoomMessages(roomName, confirm);
  }

  async getSystemMetrics(): Promise<{
    totalStorageSize: number;
    mostActiveRoom: RoomStats | null;
  }> {
    return await this.service.getSystemMetrics();
  }
}

// Export MCP tools
export { managementTools, managementToolHandlers } from './tools/management.tools';

// Default export
export default ManagementAPI;