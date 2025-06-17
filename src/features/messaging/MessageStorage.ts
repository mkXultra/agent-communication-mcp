import * as fs from 'fs/promises';
import * as path from 'path';
import { StorageError } from '../../errors/AppError';
import { Message, MessageStorageData, GetMessagesParams } from './types/messaging.types';

export class MessageStorage {
  private readonly dataDir: string;

  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
  }

  private getMessagesFilePath(roomName: string): string {
    return path.join(this.dataDir, 'rooms', roomName, 'messages.jsonl');
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      throw new StorageError(
        'createDirectory',
        `Failed to create directory: ${dirPath}`
      );
    }
  }

  async saveMessage(roomName: string, messageData: MessageStorageData): Promise<void> {
    const filePath = this.getMessagesFilePath(roomName);
    const dirPath = path.dirname(filePath);
    
    try {
      await this.ensureDirectoryExists(dirPath);
      
      const jsonLine = JSON.stringify(messageData) + '\n';
      await fs.appendFile(filePath, jsonLine, 'utf8');
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'saveMessage',
        `Failed to save message: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async getMessages(params: GetMessagesParams): Promise<{ messages: Message[]; hasMore: boolean }> {
    const filePath = this.getMessagesFilePath(params.roomName);
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    
    try {
      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        // File doesn't exist, return empty result
        return { messages: [], hasMore: false };
      }

      const fileContent = await fs.readFile(filePath, 'utf8');
      const lines = fileContent.trim().split('\n').filter(line => line.trim());
      
      // Parse all messages
      const allMessages: Message[] = [];
      for (const line of lines) {
        try {
          const data: MessageStorageData = JSON.parse(line);
          const message: Message = {
            ...data,
            roomName: params.roomName
          };
          allMessages.push(message);
        } catch (parseError) {
          // Skip malformed lines
          continue;
        }
      }

      // Filter by mentions if requested
      let filteredMessages = allMessages;
      if (params.mentionsOnly && params.agentName) {
        filteredMessages = allMessages.filter(msg => 
          msg.mentions.includes(params.agentName!)
        );
      }

      // Sort by timestamp (newest first)
      filteredMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Apply pagination
      const startIndex = offset;
      const endIndex = startIndex + limit;
      const paginatedMessages = filteredMessages.slice(startIndex, endIndex);
      const hasMore = endIndex < filteredMessages.length;

      return {
        messages: paginatedMessages,
        hasMore
      };
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'readMessages',
        `Failed to read messages: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async getMessageCount(roomName: string): Promise<number> {
    const filePath = this.getMessagesFilePath(roomName);
    
    try {
      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        return 0;
      }

      const fileContent = await fs.readFile(filePath, 'utf8');
      const lines = fileContent.trim().split('\n').filter(line => line.trim());
      return lines.length;
    } catch (error) {
      throw new StorageError(
        'getMessageCount',
        `Failed to count messages: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}