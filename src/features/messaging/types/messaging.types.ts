export interface Message {
  id: string;
  agentName: string;
  roomName: string;
  message: string;
  timestamp: string;
  mentions: string[];
  metadata?: Record<string, any>;
}

export interface SendMessageParams {
  agentName: string;
  roomName: string;
  message: string;
  metadata?: Record<string, any>;
}

export interface SendMessageResponse {
  success: boolean;
  messageId: string;
  roomName: string;
  timestamp: string;
  mentions: string[];
}

export interface GetMessagesParams {
  roomName: string;
  agentName?: string;
  limit?: number;
  offset?: number;
  mentionsOnly?: boolean;
}

export interface MessageListResponse {
  roomName: string;
  messages: Message[];
  count: number;
  hasMore: boolean;
}

export interface MessageStorageData {
  id: string;
  agentName: string;
  message: string;
  timestamp: string;
  mentions: string[];
  metadata?: Record<string, any>;
}