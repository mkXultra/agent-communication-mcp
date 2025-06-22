export interface RoomStats {
  name: string;
  onlineUsers: number;
  totalMessages: number;
  storageSize: number;
  users?: {
    [agentName: string]: {
      status: 'online' | 'offline' | 'away';
      lastSeen?: string;
    };
  };
}

export interface SystemStatus {
  rooms: RoomStats[];
  totalRooms: number;
  totalOnlineUsers: number;
  totalMessages: number;
  totalStorageSize: number;
}

export interface ClearResult {
  success: boolean;
  roomName: string;
  clearedCount: number;
}

export interface RoomScanResult {
  messageCount: number;
  onlineUsers: number;
  storageSize: number;
}

export interface FileStats {
  size: number;
  exists: boolean;
}

export interface PresenceData {
  users: {
    [agentName: string]: {
      status: 'online' | 'offline' | 'away';
      lastSeen: string;
    };
  };
}