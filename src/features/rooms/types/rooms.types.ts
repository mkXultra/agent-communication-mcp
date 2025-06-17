// Agent Communication MCP Server - Rooms Feature Type Definitions
// エージェントB担当：ルーム・プレゼンス機能専用型定義

import { Room, Agent, AgentProfile, Presence } from '../../../types/entities';

// === Room管理用の型定義 ===

export interface RoomsData {
  rooms: Record<string, RoomData>;
}

export interface RoomData {
  description?: string;
  createdAt: string;
  messageCount: number;
  userCount: number;
}

export interface CreateRoomParams {
  roomName: string;
  description?: string;
}

export interface CreateRoomResult {
  success: boolean;
  roomName: string;
  message: string;
}

export interface ListRoomsParams {
  agentName?: string;
}

export interface RoomListItem {
  name: string;
  description?: string;
  userCount: number;
  messageCount: number;
  isJoined?: boolean;
}

export interface ListRoomsResult {
  rooms: RoomListItem[];
}

// === Presence管理用の型定義 ===

export interface PresenceData {
  roomName: string;
  users: Record<string, PresenceUser>;
}

export interface PresenceUser {
  status: 'online' | 'offline';
  messageCount: number;
  joinedAt: string;
  profile?: AgentProfile;
}

export interface EnterRoomParams {
  agentName: string;
  roomName: string;
  profile?: AgentProfile;
}

export interface EnterRoomResult {
  success: boolean;
  roomName: string;
  message: string;
}

export interface LeaveRoomParams {
  agentName: string;
  roomName: string;
}

export interface LeaveRoomResult {
  success: boolean;
  roomName: string;
  message: string;
}

export interface ListRoomUsersParams {
  roomName: string;
}

export interface RoomUser {
  name: string;
  status: 'online' | 'offline';
  messageCount?: number;
  profile?: AgentProfile;
}

export interface ListRoomUsersResult {
  roomName: string;
  users: RoomUser[];
  onlineCount: number;
}

// === ストレージインターフェース ===

export interface IRoomStorage {
  readRooms(): Promise<RoomsData>;
  writeRooms(data: RoomsData): Promise<void>;
  createRoom(roomName: string, description?: string): Promise<void>;
  roomExists(roomName: string): Promise<boolean>;
  getRoomData(roomName: string): Promise<RoomData | null>;
  updateRoomUserCount(roomName: string, count: number): Promise<void>;
  getAllRoomNames(): Promise<string[]>;
  clearAllRooms(): Promise<void>;
}

export interface IPresenceStorage {
  readPresence(roomName: string): Promise<PresenceData>;
  writePresence(roomName: string, data: PresenceData): Promise<void>;
  addUser(roomName: string, agentName: string, profile?: AgentProfile): Promise<void>;
  removeUser(roomName: string, agentName: string): Promise<void>;
  updateUserStatus(roomName: string, agentName: string, status: 'online' | 'offline'): Promise<void>;
  getUsersInRoom(roomName: string): Promise<PresenceUser[]>;
  isUserInRoom(roomName: string, agentName: string): Promise<boolean>;
  getUserStatus(roomName: string, agentName: string): Promise<'online' | 'offline' | null>;
  getOnlineUsersCount(roomName: string): Promise<number>;
  incrementUserMessageCount(roomName: string, agentName: string): Promise<void>;
  clearRoomPresence(roomName: string): Promise<void>;
}

// === サービスインターフェース ===

export interface IRoomService {
  createRoom(roomName: string, description?: string): Promise<CreateRoomResult>;
  listRooms(agentName?: string): Promise<ListRoomsResult>;
  roomExists(roomName: string): Promise<boolean>;
  getRoomData(roomName: string): Promise<RoomData | null>;
}

export interface IPresenceService {
  enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<EnterRoomResult>;
  leaveRoom(agentName: string, roomName: string): Promise<LeaveRoomResult>;
  listRoomUsers(roomName: string): Promise<ListRoomUsersResult>;
  isUserInRoom(roomName: string, agentName: string): Promise<boolean>;
  getUserStatus(roomName: string, agentName: string): Promise<'online' | 'offline' | null>;
}

// === 内部ユーティリティ型 ===

export interface RoomValidationOptions {
  allowExisting?: boolean;
  requireDescription?: boolean;
}

export interface AgentValidationOptions {
  requireInRoom?: boolean;
  allowDuplicate?: boolean;
}