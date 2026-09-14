// Agent Communication MCP Server - room tools in cloud mode
// list_rooms / create_room / enter_room / leave_room / list_room_users over docs/api.yaml.

import { AgentNotInRoomError, RoomAlreadyExistsError, RoomNotFoundError } from '../errors/index.js';
import type { AgentProfile, Room } from '../types/entities.js';
import { CloudApiClient } from './CloudApiClient.js';
import { CloudWaitService } from './CloudWaitService.js';
import type { ApiMemberList } from './types.js';
import {
  agentNameValidationError,
  descriptionValidationError,
  isValidName,
  profileValidationError,
  roomNameValidationError,
} from './validation.js';

export interface CloudRoomUser {
  name: string;
  status: 'online' | 'offline';
  messageCount: number;
  profile?: AgentProfile;
}

export class CloudRoomsService {
  constructor(
    private readonly api: CloudApiClient,
    private readonly waits: CloudWaitService,
  ) {}

  /** list_rooms: GET /rooms (all pages), sorted by name like RoomService.listRooms. */
  async listRooms(): Promise<{ rooms: Room[]; total: number }> {
    const rooms = (await this.api.listRooms())
      .map(
        (room): Room => ({
          name: room.name,
          // The API stores a missing description as ''; the file mode leaves it out.
          ...(room.description ? { description: room.description } : {}),
          createdAt: room.createdAt,
          // §5.2: the counts only exist on RoomStatus; list_rooms returns 0.
          messageCount: 0,
          userCount: 0,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    // §5.2: `total` is the API's `count` (all pages are merged, so it is the number of rooms).
    return { rooms, total: rooms.length };
  }

  /** create_room: POST /rooms (409 -> RoomAlreadyExistsError). Does not enter the room. */
  async createRoom(params: { roomName: string; description?: string }): Promise<{ success: boolean; roomName: string }> {
    const invalid = roomNameValidationError(params.roomName) ?? descriptionValidationError(params.description);
    if (invalid) {
      // File mode reports an existing room before it validates the input.
      if (isValidName(params.roomName) && (await this.roomExists(params.roomName))) {
        throw new RoomAlreadyExistsError(params.roomName);
      }
      throw invalid;
    }
    const result = await this.api.createRoom(params.roomName, params.description);
    return { success: result.success, roomName: result.roomName };
  }

  /** enter_room: POST /rooms/{roomName}/join (404 -> RoomNotFoundError). Re-entering succeeds. One request. */
  async enterRoom(params: { agentName: string; roomName: string; profile?: AgentProfile }): Promise<{ success: boolean }> {
    const { agentName, roomName, profile } = params;
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));
    const invalid = agentNameValidationError(agentName) ?? profileValidationError(profile);
    if (invalid) {
      await this.assertRoomExists(roomName);
      throw invalid;
    }
    const result = await this.api.joinRoom(roomName, agentName, profile);
    // The read position before this agent sends anything, with the epoch of the room it belongs to (the same response).
    this.waits.noteJoined(roomName, agentName, result.lastReadSeq, result.alreadyMember, result.epoch);
    return { success: result.success };
  }

  /** leave_room: POST /rooms/{roomName}/leave. The member stays listed as offline. */
  async leaveRoom(params: { agentName: string; roomName: string }): Promise<{ success: boolean }> {
    const { agentName, roomName } = params;
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));
    if (!isValidName(agentName)) {
      await this.assertRoomExists(roomName);
      throw new AgentNotInRoomError(String(agentName), roomName);
    }
    try {
      const result = await this.api.leaveRoom(roomName, agentName);
      this.waits.disconnect(roomName, agentName);
      return { success: result.success };
    } catch (error) {
      if (!(error instanceof AgentNotInRoomError)) throw error;
      // The API answers 403 for a member that already left; the file mode only checks that the member
      // row exists (PresenceService.leaveRoom) and succeeds again.
      if (await this.isMember(roomName, agentName)) {
        this.waits.disconnect(roomName, agentName);
        return { success: true };
      }
      throw error;
    }
  }

  /** list_room_users: GET /rooms/{roomName}/members, offline members included. */
  async listRoomUsers(params: { roomName: string }): Promise<{ roomName: string; users: CloudRoomUser[]; onlineCount: number }> {
    const { roomName } = params;
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));
    const list = await this.api.listMembers(roomName, true);
    const users = list.members
      .map(
        (member): CloudRoomUser => ({
          name: member.agentName,
          status: member.status,
          // Presence.messageCount is never incremented by the file mode either.
          messageCount: 0,
          ...(member.profile !== undefined ? { profile: member.profile } : {}),
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return { roomName, users, onlineCount: list.onlineCount };
  }

  async roomExists(roomName: string): Promise<boolean> {
    if (!isValidName(roomName)) return false;
    try {
      await this.api.listMembers(roomName, false);
      return true;
    } catch (error) {
      if (error instanceof RoomNotFoundError) return false;
      throw error;
    }
  }

  /** Names of all members (online and offline), like RoomsAdapter.getRoomUsers. */
  async getRoomUsers(roomName: string): Promise<string[]> {
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));
    const list = await this.api.listMembers(roomName, true);
    return list.members.map((member) => member.agentName);
  }

  /** Throws RoomNotFoundError when the room does not exist. */
  async assertRoomExists(roomName: string): Promise<ApiMemberList> {
    return this.api.listMembers(roomName, true);
  }

  /** The file-mode membership check: the agent has a member row, whatever its status. */
  async assertMember(roomName: string, agentName: string): Promise<void> {
    const list = await this.assertRoomExists(roomName);
    if (!list.members.some((member) => member.agentName === agentName)) {
      throw new AgentNotInRoomError(agentName, roomName);
    }
  }

  private async isMember(roomName: string, agentName: string): Promise<boolean> {
    const list = await this.api.listMembers(roomName, true);
    return list.members.some((member) => member.agentName === agentName);
  }
}
