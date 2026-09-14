// Agent Communication MCP Server - management tools in cloud mode
// get_status -> GET /status, clear_room_messages -> DELETE /rooms/{roomName}/messages (D2).

import { RoomNotFoundError } from '../errors/index.js';
import { CloudApiClient } from './CloudApiClient.js';
import { CloudWaitService } from './CloudWaitService.js';
import type { ApiStatus } from './types.js';
import { isValidName } from './validation.js';

const MEMBER_LOOKUP_CONCURRENCY = 5;

export interface CloudRoomStats {
  name: string;
  onlineUsers: number;
  totalMessages: number;
  storageSize: number;
}

export class CloudManagementService {
  constructor(
    private readonly api: CloudApiClient,
    private readonly waits: CloudWaitService,
  ) {}

  /**
   * get_status. Like ManagementAdapter.getStatus in file mode, `roomName` does not narrow the result.
   */
  async getStatus(_params?: { roomName?: string }): Promise<{
    rooms: CloudRoomStats[];
    totalRooms: number;
    totalOnlineUsers: number;
    totalMessages: number;
  }> {
    const status = await this.api.getStatus();
    return {
      rooms: status.rooms.map((room) => ({
        name: room.roomName,
        onlineUsers: room.onlineCount,
        totalMessages: room.messageCount,
        storageSize: room.storageBytes ?? 0,
      })),
      totalRooms: status.totalRooms,
      totalOnlineUsers: await this.countOnlineAgents(status),
      totalMessages: status.totalMessages,
    };
  }

  /** clear_room_messages. `confirm=true` is only sent when confirmed (400 -> ConfirmationRequiredError). */
  async clearRoomMessages(params: {
    roomName: string;
    confirm: boolean;
  }): Promise<{ success: boolean; roomName: string; clearedCount: number }> {
    const { roomName } = params;
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));
    const result = await this.api.clearRoomMessages(roomName, Boolean(params.confirm));
    this.waits.invalidateRoom(roomName);
    return { success: result.success, roomName: result.roomName, clearedCount: result.clearedCount };
  }

  /**
   * The file mode counts unique online agent names across rooms, while GET /status sums the per-room
   * counts. With more than one room that has online members, the names are looked up per room.
   */
  private async countOnlineAgents(status: ApiStatus): Promise<number> {
    const rooms = status.rooms.filter((room) => room.onlineCount > 0);
    if (rooms.length <= 1) return rooms[0]?.onlineCount ?? 0;

    const names = new Set<string>();
    const queue = [...rooms];
    const worker = async (): Promise<void> => {
      for (let room = queue.shift(); room; room = queue.shift()) {
        try {
          const list = await this.api.listMembers(room.roomName, false);
          for (const member of list.members) {
            if (member.status === 'online') names.add(member.agentName);
          }
        } catch (error) {
          // A room deleted since GET /status has nobody online any more.
          if (!(error instanceof RoomNotFoundError)) throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MEMBER_LOOKUP_CONCURRENCY, rooms.length) }, worker));
    return names.size;
  }
}
