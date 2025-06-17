// Agent Communication MCP Server - 管理ツールのZodスキーマ定義

import { z } from 'zod';

// 共通のバリデーションルール
const roomNameSchema = z
  .string()
  .min(1, 'Room name cannot be empty')
  .max(50, 'Room name cannot exceed 50 characters')
  .regex(/^[a-zA-Z0-9-_]+$/, 'Room name must contain only alphanumeric characters, hyphens, and underscores');

// get_status ツール
export const getStatusInputSchema = z.object({
  roomName: roomNameSchema.optional(),
});

// spec.md lines 157-167 準拠
export const getStatusOutputSchema = z.object({
  rooms: z.array(z.object({
    name: z.string(),
    onlineUsers: z.number(),
    totalMessages: z.number(),
    storageSize: z.number(),
  })),
  totalRooms: z.number(),
  totalOnlineUsers: z.number(),
  totalMessages: z.number(),
});

// clear_room_messages ツール (spec.md line 172-179 準拠)
export const clearRoomMessagesInputSchema = z.object({
  roomName: roomNameSchema,
  confirm: z.boolean(), // spec要件に従い必須パラメータ
});

export const clearRoomMessagesOutputSchema = z.object({
  success: z.boolean(),
  roomName: z.string(),
  clearedCount: z.number(), // spec要件: clearedCount
});

// get_room_statistics ツール
export const getRoomStatisticsInputSchema = z.object({
  roomName: roomNameSchema,
  includeHistory: z.boolean().default(false),
  timeRange: z.object({
    from: z.string().refine((val) => !isNaN(Date.parse(val)), 'Invalid from timestamp'),
    to: z.string().refine((val) => !isNaN(Date.parse(val)), 'Invalid to timestamp'),
  }).optional(),
});

export const getRoomStatisticsOutputSchema = z.object({
  roomName: z.string(),
  totalMessages: z.number(),
  uniqueAgents: z.number(),
  messagesByAgent: z.record(z.number()),
  firstMessageAt: z.string().optional(),
  lastMessageAt: z.string().optional(),
  averageMessagesPerDay: z.number().optional(),
  mostActiveAgent: z.string().optional(),
  peakActivity: z.object({
    date: z.string(),
    messageCount: z.number(),
  }).optional(),
  timeRange: z.object({
    from: z.string(),
    to: z.string(),
  }).optional(),
});

// export_room_data ツール（将来の拡張用）
export const exportRoomDataInputSchema = z.object({
  roomName: roomNameSchema,
  format: z.enum(['json', 'csv', 'txt']).default('json'),
  includeMetadata: z.boolean().default(false),
  timeRange: z.object({
    from: z.string().refine((val) => !isNaN(Date.parse(val)), 'Invalid from timestamp'),
    to: z.string().refine((val) => !isNaN(Date.parse(val)), 'Invalid to timestamp'),
  }).optional(),
});

export const exportRoomDataOutputSchema = z.object({
  success: z.boolean(),
  roomName: z.string(),
  format: z.string(),
  dataSize: z.number(),
  messageCount: z.number(),
  exportedAt: z.string(),
  downloadUrl: z.string().optional(),
  data: z.any().optional(),
});

// backup_room ツール（将来の拡張用）
export const backupRoomInputSchema = z.object({
  roomName: roomNameSchema,
  includePresence: z.boolean().default(true),
  compression: z.boolean().default(true),
});

export const backupRoomOutputSchema = z.object({
  success: z.boolean(),
  roomName: z.string(),
  backupId: z.string(),
  backupSize: z.number(),
  messageCount: z.number(),
  presenceCount: z.number(),
  backedUpAt: z.string(),
  backupPath: z.string().optional(),
});

// restore_room ツール（将来の拡張用）
export const restoreRoomInputSchema = z.object({
  backupId: z.string().min(1, 'Backup ID cannot be empty'),
  targetRoomName: roomNameSchema.optional(),
  overwriteExisting: z.boolean().default(false),
});

export const restoreRoomOutputSchema = z.object({
  success: z.boolean(),
  backupId: z.string(),
  roomName: z.string(),
  restoredMessageCount: z.number(),
  restoredPresenceCount: z.number(),
  restoredAt: z.string(),
  overwritten: z.boolean(),
});

// エイリアスを追加（後方互換性のため）
export const getStatusSchema = getStatusInputSchema;
export const clearRoomMessagesSchema = clearRoomMessagesInputSchema;

// 型定義をエクスポート
export type GetStatusInput = z.infer<typeof getStatusInputSchema>;
export type GetStatusOutput = z.infer<typeof getStatusOutputSchema>;
export type ClearRoomMessagesInput = z.infer<typeof clearRoomMessagesInputSchema>;
export type ClearRoomMessagesOutput = z.infer<typeof clearRoomMessagesOutputSchema>;
export type GetRoomStatisticsInput = z.infer<typeof getRoomStatisticsInputSchema>;
export type GetRoomStatisticsOutput = z.infer<typeof getRoomStatisticsOutputSchema>;
export type ExportRoomDataInput = z.infer<typeof exportRoomDataInputSchema>;
export type ExportRoomDataOutput = z.infer<typeof exportRoomDataOutputSchema>;
export type BackupRoomInput = z.infer<typeof backupRoomInputSchema>;
export type BackupRoomOutput = z.infer<typeof backupRoomOutputSchema>;
export type RestoreRoomInput = z.infer<typeof restoreRoomInputSchema>;
export type RestoreRoomOutput = z.infer<typeof restoreRoomOutputSchema>;