// Agent Communication MCP Server - messaging tools in cloud mode
// send_message / get_messages / wait_for_messages / download_attachment over docs/api.yaml.

import { randomUUID } from 'crypto';
import path from 'path';
import { AgentNotInRoomError, AppError, RoomNotFoundError } from '../errors/index.js';
import { WAIT_CONSTANTS } from '../features/messaging/constants.js';
import { MessageValidator } from '../features/messaging/MessageValidator.js';
import type { GetMessagesParams, WaitForMessagesParams } from '../features/messaging/types/messaging.types.js';
import type { Message } from '../types/entities.js';
import {
  assertNotExists,
  inspectAttachments,
  isUsableFileName,
  openAttachment,
  resolveSaveTarget,
  saveNewFile,
  type LocalAttachment,
} from './attachments.js';
import { CloudApiClient } from './CloudApiClient.js';
import { CloudRoomsService } from './CloudRoomsService.js';
import { CloudWaitService } from './CloudWaitService.js';
import { toToolMessage, type WaitForMessagesResult } from './mappers.js';
import type { ApiMessage, ApiMessageList } from './types.js';
import { downloadParamsValidationError, isValidName, roomNameValidationError } from './validation.js';

export interface DownloadAttachmentResult {
  /** Absolute path of the saved file. */
  path: string;
  name: string;
  /** Bytes written. */
  size: number;
  /** The Content-Type of the download (agora serves HTML-like types as application/octet-stream). */
  contentType: string;
}

/** docs/api.yaml `getMessages.limit`: 1..1000. */
const PAGE_LIMIT = 1000;

export class CloudMessagingService {
  constructor(
    private readonly api: CloudApiClient,
    private readonly rooms: CloudRoomsService,
    private readonly waits: CloudWaitService,
  ) {}

  /**
   * send_message: one POST (§5.3 — room and membership are checked by the Room DO).
   * A fresh `clientMessageId` lets the client resend after a transient failure without duplicates.
   * The first send for a room x agent this process has no read cursor for (the agent entered from another
   * process) looks the member's read position up first, because the send moves it past older messages. If that
   * look-up fails, nothing is sent: sending would hide the messages that are still unread.
   *
   * `attachments` (§3.9): local file paths, checked before anything is uploaded (count, existence, regular file, size;
   * no API call), then uploaded one by one, and their IDs sent with the message. When one fails nothing is sent.
   * Cancelling the call (`signal`) stops the uploads and the send that would follow them.
   */
  async sendMessage(
    params: {
      agentName: string;
      roomName: string;
      message: string;
      metadata?: Record<string, unknown>;
      attachments?: string[];
    },
    signal?: AbortSignal,
  ): Promise<{ success: boolean; messageId: string; timestamp: string; roomName: string; mentions: string[] }> {
    const { agentName, roomName } = params;
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));
    try {
      MessageValidator.validateSendMessage(params);
      if (!isValidName(agentName)) throw new AgentNotInRoomError(String(agentName), roomName);
    } catch (error) {
      // File mode checks the room and the membership before it validates the input.
      await this.rooms.assertMember(roomName, String(agentName));
      throw error;
    }
    const files = params.attachments === undefined ? [] : await inspectAttachments(params.attachments);

    await this.waits.ensureCursor(roomName, agentName);

    const attachmentIds = await this.uploadAttachments(roomName, agentName, files, signal);
    const result = await this.api.sendMessage(
      roomName,
      {
        agentName,
        message: params.message,
        clientMessageId: randomUUID(),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
        ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
      },
      attachmentIds.length > 0 && signal ? { signal } : {},
    );
    return {
      success: result.success,
      messageId: result.messageId,
      timestamp: result.timestamp,
      roomName: result.roomName,
      mentions: result.mentions,
    };
  }

  /**
   * download_attachment (§3.9): GET /rooms/{roomName}/attachments/{attachmentId}, streamed to a local file. `savePath` is
   * an existing directory (the file is saved there under the attachment's name) or the path of a new file in an
   * existing directory. An existing file is never replaced, and a failed download leaves no file behind.
   */
  async downloadAttachment(
    params: { roomName: string; attachmentId: string; savePath: string },
    signal?: AbortSignal,
  ): Promise<DownloadAttachmentResult> {
    const { roomName, attachmentId, savePath } = params;
    const invalid = roomNameValidationError(roomName) ?? downloadParamsValidationError(attachmentId, savePath);
    if (invalid) throw invalid;

    const target = await resolveSaveTarget(savePath);
    return this.api.downloadAttachment(
      roomName,
      attachmentId,
      async (download): Promise<DownloadAttachmentResult> => {
        const { name } = download;
        if (name === undefined || !isUsableFileName(name)) {
          throw new AppError(`Cloud API did not give attachment '${attachmentId}' a usable file name`, 'INTERNAL_ERROR', 502);
        }
        let file: string;
        if ('file' in target) {
          file = target.file;
        } else {
          file = path.join(target.directory, name);
          await assertNotExists(file);
        }
        const size = await saveNewFile(file, download.body);
        return { path: file, name, size, contentType: download.contentType };
      },
      signal ? { signal } : {},
    );
  }

  /**
   * Uploads the files one after another and returns their IDs in the same order. When one fails, the error is thrown
   * and the uploads made so far are left to agora, which deletes an upload that no message took after an hour.
   */
  private async uploadAttachments(
    roomName: string,
    agentName: string,
    files: LocalAttachment[],
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, file] of files.entries()) {
      const field = `attachments[${index}]`;
      const reader = await openAttachment(file, field);
      try {
        const uploaded = await this.api.uploadAttachment(
          roomName,
          agentName,
          { name: file.name, contentType: file.contentType, size: reader.size, body: reader.chunks },
          {
            ...(signal ? { signal } : {}),
            context: { roomName, agentName, file: file.path, field, operation: 'upload attachment' },
          },
        );
        ids.push(uploaded.attachmentId);
      } finally {
        await reader.close();
      }
    }
    return ids;
  }

  /**
   * get_messages: newest first with `offset` / `limit`, rebuilt from "latest N" (no `since`) and
   * `before` paging. `mentionsOnly` is filtered on the client so paging stays exact.
   */
  async getMessages(params: {
    agentName?: string;
    roomName: string;
    limit?: number;
    offset?: number;
    mentionsOnly?: boolean;
  }): Promise<{ roomName: string; messages: Message[]; count: number; hasMore: boolean }> {
    const { roomName, agentName } = params;
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));

    let validated: GetMessagesParams;
    try {
      validated = MessageValidator.validateGetMessages(params);
      if (agentName && !isValidName(agentName)) throw new AgentNotInRoomError(agentName, roomName);
    } catch (error) {
      if (agentName) await this.rooms.assertMember(roomName, agentName);
      else await this.rooms.assertRoomExists(roomName);
      throw error;
    }

    const limit = validated.limit ?? 20;
    const offset = validated.offset ?? 0;
    const mentionFilter = validated.mentionsOnly && agentName ? agentName : undefined;
    // One more than needed tells whether there is more.
    const needed = offset + limit + 1;
    let queryAgent = agentName || undefined;
    let before: number | undefined;
    const collected: ApiMessage[] = [];

    for (;;) {
      let page: ApiMessageList;
      try {
        page = await this.api.getMessages(roomName, {
          limit: mentionFilter ? PAGE_LIMIT : Math.min(PAGE_LIMIT, needed - collected.length),
          ...(before !== undefined ? { before } : {}),
          ...(queryAgent ? { agentName: queryAgent } : {}),
        });
      } catch (error) {
        if (!(error instanceof AgentNotInRoomError) || !queryAgent) throw error;
        // The API treats an offline member as not in the room; the file mode lets any member row read.
        await this.rooms.assertMember(roomName, queryAgent);
        queryAgent = undefined;
        continue;
      }

      for (const message of page.messages) {
        if (!mentionFilter || message.mentions.includes(mentionFilter)) collected.push(message);
      }
      if (collected.length >= needed || !page.hasMore || page.messages.length === 0) break;
      before = page.messages[page.messages.length - 1]!.seq;
    }

    const messages = collected.slice(offset, offset + limit).map(toToolMessage);
    return { roomName, messages, count: messages.length, hasMore: collected.length > offset + limit };
  }

  /**
   * wait_for_messages: WebSocket wait with long polling as the fallback (CloudWaitService). `timeout` 0 waits until a
   * message arrives; `mentionsOnly` returns only messages that mention the agent; `signal` ends the wait without a result.
   */
  async waitForMessages(
    params: { agentName: string; roomName: string; timeout?: number; mentionsOnly?: boolean },
    signal?: AbortSignal,
  ): Promise<WaitForMessagesResult> {
    const { agentName, roomName } = params;
    if (!isValidName(roomName)) throw new RoomNotFoundError(String(roomName));

    let validated: WaitForMessagesParams;
    try {
      validated = MessageValidator.validateWaitForMessages(params);
    } catch (error) {
      await this.rooms.assertMember(roomName, String(agentName));
      throw error;
    }
    const timeoutMs = validated.timeout ?? WAIT_CONSTANTS.DEFAULT_TIMEOUT;
    return this.waits.waitForMessages(validated.agentName, validated.roomName, timeoutMs, validated.mentionsOnly ?? false, signal);
  }
}
