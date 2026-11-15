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

// 本文の上限。agora（docs/cloud-architecture.md §9 `MAX_MESSAGE_LENGTH`）と同じくコードポイント数で数える
export const MESSAGE_MAX_LENGTH = 10000;

// z.string().max() と同じ too_big を、UTF-16 のコードユニット数ではなくコードポイント数で判定する
export function maxCodePoints(maximum: number, message?: string) {
  return (value: string, ctx: z.RefinementCtx): void => {
    if (Array.from(value).length > maximum) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum,
        type: 'string',
        inclusive: true,
        exact: false,
        ...(message === undefined ? {} : { message }),
      });
    }
  };
}

const messageContentSchema = z
  .string()
  .min(1, 'Message cannot be empty')
  .superRefine(maxCodePoints(MESSAGE_MAX_LENGTH, `Message cannot exceed ${MESSAGE_MAX_LENGTH} characters`));

// 添付ファイル（クラウドモードのみ。docs/cloud-architecture.md §3.9）
const attachmentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
});

// send_message ツール（実装済み）
// attachments はローカルファイルのパス（件数・存在・サイズはクラウドモードで送信前に検査。ファイルモードでは指定するとエラー）
export const sendMessageInputSchema = z.object({
  agentName: agentNameSchema,
  roomName: roomNameSchema,
  message: messageContentSchema,
  metadata: z.record(z.any()).optional(),
  attachments: z.array(z.string()).optional(),
});

// The public send_message inputs (MCP): agentName is no longer one of them. The acting name is the one
// enter_room selected for the room on this MCP connection; the MCP-facing layer rejects a caller that still
// supplies agentName and injects the selected name before the adapter sees the internal shape above.
export const publicSendMessageInputSchema = sendMessageInputSchema.omit({ agentName: true });

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
  limit: z.number().int().min(1).max(1000).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  mentionsOnly: z.boolean().optional().default(false),
});

export const getMessagesOutputSchema = z.object({
  roomName: z.string(),
  messages: z.array(z.object({
    id: z.string(),
    seq: z.number().int().optional(),
    agentName: z.string(),
    roomName: z.string(),
    message: z.string(),
    timestamp: z.string(),
    mentions: z.array(z.string()),
    metadata: z.record(z.any()).optional(),
    attachments: z.array(attachmentInfoSchema).optional(),
  })),
  count: z.number(),
  hasMore: z.boolean(),
});

// wait_for_messages ツール（timeout はミリ秒。ツール定義の 1〜300 秒・既定 30 秒と同じ範囲で、0 はメッセージが届くまで無期限に待つ）
// mentionsOnly は agentName 宛のメンションを含むメッセージだけを返す（それ以外は既読にして待ち続ける）
export const waitForMessagesInputSchema = z.object({
  agentName: agentNameSchema,
  roomName: roomNameSchema,
  timeout: z.number()
    .int()
    .refine((timeout) => timeout === 0 || timeout >= 1000, 'Timeout must be at least 1000ms, or 0 to wait until a message arrives')
    .refine((timeout) => timeout <= 300000, 'Timeout cannot exceed 300000ms')
    .optional()
    .default(30000),
  mentionsOnly: z.boolean().optional().default(false),
});

// The public wait_for_messages inputs (MCP): agentName is no longer one of them, for the same reason as send_message
// above. `timeout` stays in seconds here, like the tool's inputSchema; the schema deliberately does not bound it,
// because the adapter validates it after converting to milliseconds and callers rely on that error. The MCP-facing
// layer rejects a caller that still supplies agentName and injects the selected name before the internal shape above.
export const publicWaitForMessagesInputSchema = z.object({
  roomName: roomNameSchema,
  timeout: z.number().optional(),
  mentionsOnly: z.boolean().optional(),
});

export const waitForMessagesOutputSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    seq: z.number().int().optional(),
    agentName: z.string(),
    roomName: z.string(),
    message: z.string(),
    timestamp: z.string(),
    mentions: z.array(z.string()),
    metadata: z.record(z.any()).optional(),
    attachments: z.array(attachmentInfoSchema).optional(),
  })),
  hasNewMessages: z.boolean(),
  timedOut: z.boolean(),
  warning: z.string().optional(),
  waitingAgents: z.array(z.string()).optional(),
});

// download_attachment ツール（クラウドモードのみ。形式の検査は CloudMessagingService でも行う）
export const downloadAttachmentInputSchema = z.object({
  roomName: roomNameSchema,
  attachmentId: z.string(),
  savePath: z.string(),
});

export const downloadAttachmentOutputSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
});

// delete_attachments_through_post ツール（クラウドモードのみ）
// throughSeq は get_messages / wait_for_messages が返すメッセージの seq（ルーム内の位置）。
// confirm なし（既定）は状態を変えないプレビュー、confirm: true で実行する（プレビューは任意）。
// 実行は roomName + throughSeq だけで行い、リクエスト時の現在の同名ルームを対象にする。
export const deleteAttachmentsThroughPostInputSchema = z.object({
  roomName: roomNameSchema,
  throughSeq: z
    .number()
    .refine(Number.isSafeInteger, 'Through post position must be a safe integer')
    .refine((value) => value >= 1, 'Through post position must be >= 1'),
  confirm: z.boolean().optional().default(false),
});

const attachmentPurgePreviewOutputSchema = z.object({
  dryRun: z.literal(true),
  roomName: z.string(),
  throughSeq: z.number().int(),
  latestSeq: z.number().int(),
  oldestSeq: z.number().int().optional(),
  boundaryMessageExists: z.boolean(),
  boundaryMessageId: z.string().optional(),
  attachmentCount: z.number().int(),
  attachmentBytes: z.number().int(),
  firstAttachmentSeq: z.number().int().optional(),
  lastAttachmentSeq: z.number().int().optional(),
  messagesThroughBoundary: z.number().int(),
  unpostedAttachmentCount: z.number().int(),
  unpostedAttachmentBytes: z.number().int(),
  // Display-only rows from automatic retention; not live storage and not what an execute deletes.
  retainedDisplayMetadataCount: z.number().int(),
  afterBoundaryAttachmentCount: z.number().int(),
  afterBoundaryAttachmentBytes: z.number().int(),
  previewedAt: z.string(),
});

const attachmentPurgeResultOutputSchema = z.object({
  success: z.literal(true),
  roomName: z.string(),
  throughSeq: z.number().int(),
  deletionStatus: z.enum(['complete', 'pending']),
  deletedAttachmentCount: z.number().int(),
  deletedAttachmentBytes: z.number().int(),
  pendingAttachments: z.number().int(),
  retryAfterMs: z.number().int().optional(),
  executedAt: z.string(),
});

export const deleteAttachmentsThroughPostOutputSchema = z.union([
  attachmentPurgePreviewOutputSchema,
  attachmentPurgeResultOutputSchema,
]);

// エイリアスを追加（後方互換性のため）
export const sendMessageSchema = sendMessageInputSchema;
export const getMessagesSchema = getMessagesInputSchema;
export const downloadAttachmentSchema = downloadAttachmentInputSchema;
export const deleteAttachmentsThroughPostSchema = deleteAttachmentsThroughPostInputSchema;

// 型定義をエクスポート（実装済み機能のみ）
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export type SendMessageOutput = z.infer<typeof sendMessageOutputSchema>;
export type GetMessagesInput = z.infer<typeof getMessagesInputSchema>;
export type GetMessagesOutput = z.infer<typeof getMessagesOutputSchema>;
export type WaitForMessagesInput = z.infer<typeof waitForMessagesInputSchema>;
export type PublicWaitForMessagesInput = z.infer<typeof publicWaitForMessagesInputSchema>;
export type WaitForMessagesOutput = z.infer<typeof waitForMessagesOutputSchema>;
export type DownloadAttachmentInput = z.infer<typeof downloadAttachmentInputSchema>;
export type DownloadAttachmentOutput = z.infer<typeof downloadAttachmentOutputSchema>;
export type DeleteAttachmentsThroughPostInput = z.infer<typeof deleteAttachmentsThroughPostInputSchema>;
export type DeleteAttachmentsThroughPostOutput = z.infer<typeof deleteAttachmentsThroughPostOutputSchema>;