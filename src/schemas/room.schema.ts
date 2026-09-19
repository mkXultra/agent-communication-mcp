// Agent Communication MCP Server - ルーム管理ツールのZodスキーマ定義

import { z } from 'zod';
import { maxCodePoints } from './message.schema';

// 共通のバリデーションルール
const roomNameSchema = z
  .string()
  .min(1, 'Room name cannot be empty')
  .max(50, 'Room name cannot exceed 50 characters')
  .regex(/^[a-zA-Z0-9-_]+$/, 'Room name must contain only alphanumeric characters, hyphens, and underscores');

const agentNameSchema = z
  .string()
  .min(1, 'Agent name cannot be empty')
  .max(50, 'Agent name cannot exceed 50 characters');

// agora docs/api.yaml `AgentProfile`: role <= 100, description <= 500, capabilities <= 50 entries of <= 100
// characters, metadata a JSON object. `.strict()` matches the `additionalProperties: false` the enter_room tool
// declares, so an unknown key is reported instead of being dropped silently.
// The lengths are code points, as agora counts them (`codePointLength` in its assertProfile), so an emoji counts
// as one character in both; z.string().max() would count it as the two UTF-16 code units it takes.
const agentProfileSchema = z.object({
  role: z.string().superRefine(maxCodePoints(100, 'Profile role cannot exceed 100 characters')).optional(),
  description: z
    .string()
    .superRefine(maxCodePoints(500, 'Profile description cannot exceed 500 characters'))
    .optional(),
  capabilities: z
    .array(z.string().superRefine(maxCodePoints(100, 'Each capability cannot exceed 100 characters')))
    .max(50, 'Profile capabilities cannot exceed 50 items')
    .optional(),
  metadata: z.record(z.any()).optional(),
}).strict().optional();

// create_room ツール
export const createRoomInputSchema = z.object({
  roomName: roomNameSchema,
  description: z.string().max(200, 'Description cannot exceed 200 characters').optional(),
});

export const createRoomOutputSchema = z.object({
  success: z.boolean(),
  roomName: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
});

// list_rooms ツール
export const listRoomsInputSchema = z.object({
  agentName: agentNameSchema.optional(),
});

export const listRoomsOutputSchema = z.object({
  rooms: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    createdAt: z.string(),
    messageCount: z.number(),
    userCount: z.number(),
    lastMessageAt: z.string().optional(), // クラウドモードのみ
  })),
  total: z.number(),
});

// enter_room ツール
export const enterRoomInputSchema = z.object({
  agentName: agentNameSchema,
  roomName: roomNameSchema,
  profile: agentProfileSchema,
});

export const enterRoomOutputSchema = z.object({
  success: z.boolean(),
  agentName: z.string(),
  roomName: z.string(),
  joinedAt: z.string(),
});

// leave_room ツール
export const leaveRoomInputSchema = z.object({
  agentName: agentNameSchema,
  roomName: roomNameSchema,
});

export const leaveRoomOutputSchema = z.object({
  success: z.boolean(),
  agentName: z.string(),
  roomName: z.string(),
  leftAt: z.string(),
});

// list_room_users ツール
export const listRoomUsersInputSchema = z.object({
  roomName: roomNameSchema,
});

export const listRoomUsersOutputSchema = z.object({
  roomName: z.string(),
  users: z.array(z.object({
    agentName: z.string(),
    status: z.enum(['online', 'offline']),
    joinedAt: z.string(),
    messageCount: z.number(),
    profile: agentProfileSchema,
  })),
  total: z.number(),
});

// delete_room ツール
export const deleteRoomInputSchema = z.object({
  roomName: roomNameSchema,
});

export const deleteRoomOutputSchema = z.object({
  success: z.boolean(),
  roomName: z.string(),
  deletedAt: z.string(),
});

// エイリアスを追加（後方互換性のため）
export const createRoomSchema = createRoomInputSchema;
export const listRoomsSchema = listRoomsInputSchema;
export const enterRoomSchema = enterRoomInputSchema;
export const leaveRoomSchema = leaveRoomInputSchema;
export const listRoomUsersSchema = listRoomUsersInputSchema;

// 型定義をエクスポート
export type CreateRoomInput = z.infer<typeof createRoomInputSchema>;
export type CreateRoomOutput = z.infer<typeof createRoomOutputSchema>;
export type ListRoomsInput = z.infer<typeof listRoomsInputSchema>;
export type ListRoomsOutput = z.infer<typeof listRoomsOutputSchema>;
export type EnterRoomInput = z.infer<typeof enterRoomInputSchema>;
export type EnterRoomOutput = z.infer<typeof enterRoomOutputSchema>;
export type LeaveRoomInput = z.infer<typeof leaveRoomInputSchema>;
export type LeaveRoomOutput = z.infer<typeof leaveRoomOutputSchema>;
export type ListRoomUsersInput = z.infer<typeof listRoomUsersInputSchema>;
export type ListRoomUsersOutput = z.infer<typeof listRoomUsersOutputSchema>;
export type DeleteRoomInput = z.infer<typeof deleteRoomInputSchema>;
export type DeleteRoomOutput = z.infer<typeof deleteRoomOutputSchema>;