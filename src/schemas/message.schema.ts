// Agent Communication MCP Server - メッセージング機能の実装済みZodスキーマ定義
// このファイルは実際の実装に合わせて作成されています

import { z } from 'zod';

// 共通のバリデーションルール（実装済み）
const roomNameSchema = z
  .string()
  .min(1, 'Room name cannot be empty')
  .max(50, 'Room name cannot exceed 50 characters')
  .regex(/^[a-zA-Z0-9-_]+$/, 'Room name must contain only alphanumeric characters, hyphens, and underscores');

const agentNameSchema = z
  .string()
  .min(1, 'Agent name cannot be empty')
  .max(50, 'Agent name cannot exceed 50 characters');

const messageContentSchema = z
  .string()
  .min(1, 'Message cannot be empty')
  .max(1000, 'Message cannot exceed 1000 characters');

// send_message ツール（実装済み）
export const sendMessageInputSchema = z.object({
  agentName: agentNameSchema,
  roomName: roomNameSchema,
  message: messageContentSchema,
  metadata: z.record(z.any()).optional(),
});

export const sendMessageOutputSchema = z.object({
  success: z.boolean(),
  messageId: z.string(),
  roomName: z.string(),
  timestamp: z.string(),
  mentions: z.array(z.string()),
});

// get_messages ツール（実装済み）
export const getMessagesInputSchema = z.object({
  roomName: roomNameSchema,
  agentName: agentNameSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  mentionsOnly: z.boolean().optional().default(false),
});

export const getMessagesOutputSchema = z.object({
  roomName: z.string(),
  messages: z.array(z.object({
    id: z.string(),
    agentName: z.string(),
    roomName: z.string(),
    message: z.string(),
    timestamp: z.string(),
    mentions: z.array(z.string()),
    metadata: z.record(z.any()).optional(),
  })),
  count: z.number(),
  hasMore: z.boolean(),
});

// wait_for_messages ツール
export const waitForMessagesInputSchema = z.object({
  agentName: agentNameSchema,
  roomName: roomNameSchema,
  timeout: z.number()
    .int()
    .min(1000, 'Timeout must be at least 1000ms')
    .max(120000, 'Timeout cannot exceed 120000ms')
    .optional()
    .default(120000),
});

export const waitForMessagesOutputSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    agentName: z.string(),
    roomName: z.string(),
    message: z.string(),
    timestamp: z.string(),
    mentions: z.array(z.string()),
    metadata: z.record(z.any()).optional(),
  })),
  hasNewMessages: z.boolean(),
  timedOut: z.boolean(),
  warning: z.string().optional(),
  waitingAgents: z.array(z.string()).optional(),
});

// エイリアスを追加（後方互換性のため）
export const sendMessageSchema = sendMessageInputSchema;
export const getMessagesSchema = getMessagesInputSchema;

// 型定義をエクスポート（実装済み機能のみ）
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export type SendMessageOutput = z.infer<typeof sendMessageOutputSchema>;
export type GetMessagesInput = z.infer<typeof getMessagesInputSchema>;
export type GetMessagesOutput = z.infer<typeof getMessagesOutputSchema>;
export type WaitForMessagesInput = z.infer<typeof waitForMessagesInputSchema>;
export type WaitForMessagesOutput = z.infer<typeof waitForMessagesOutputSchema>;