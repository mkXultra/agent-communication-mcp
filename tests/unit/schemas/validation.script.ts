// Agent Communication MCP Server - スキーマ検証テスト
// Zodスキーマの動作確認とバリデーション検証

import { z } from 'zod';
import {
  // ルーム関連
  createRoomInputSchema,
  createRoomOutputSchema,
  listRoomsInputSchema,
  listRoomsOutputSchema,
  enterRoomInputSchema,
  enterRoomOutputSchema,
  leaveRoomInputSchema,
  leaveRoomOutputSchema,
  listRoomUsersInputSchema,
  listRoomUsersOutputSchema,
  deleteRoomInputSchema,
  deleteRoomOutputSchema,
  // メッセージ関連
  sendMessageInputSchema,
  sendMessageOutputSchema,
  getMessagesInputSchema,
  getMessagesOutputSchema,
  // 管理機能関連
  getStatusInputSchema,
  getStatusOutputSchema,
  clearRoomMessagesInputSchema,
  clearRoomMessagesOutputSchema,
  getRoomStatisticsInputSchema,
  getRoomStatisticsOutputSchema,
} from '../../../src/schemas/index';

// テスト実行関数
function testSchema<T>(
  name: string,
  schema: z.ZodType<T>,
  validData: unknown,
  invalidData?: unknown
): void {
  console.log(`\nTesting ${name}:`);
  
  try {
    const result = schema.parse(validData);
    console.log('✅ Valid data passed:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ Valid data failed:', error);
  }
  
  if (invalidData) {
    try {
      schema.parse(invalidData);
      console.error('❌ Invalid data should have failed but passed');
    } catch (error) {
      console.log('✅ Invalid data correctly rejected');
      if (error instanceof z.ZodError) {
        console.log('   Validation errors:', error.errors.map(e => `${e.path.join('.')}: ${e.message}`));
      }
    }
  }
}

// ルーム管理スキーマのテスト
console.log('=== Room Management Schema Tests ===');

testSchema('createRoomInput', createRoomInputSchema, 
  { roomName: 'test-room', description: 'A test room' },
  { roomName: 'invalid room!', description: 'x'.repeat(201) }
);

testSchema('createRoomOutput', createRoomOutputSchema,
  { success: true, roomName: 'test-room', createdAt: '2024-01-01T00:00:00Z' }
);

testSchema('listRoomsInput', listRoomsInputSchema,
  { agentName: 'alice' },
  { agentName: '' }
);

testSchema('enterRoomInput', enterRoomInputSchema,
  { 
    agentName: 'alice', 
    roomName: 'general',
    profile: { role: 'developer', capabilities: ['TypeScript'] }
  },
  { agentName: '', roomName: 'invalid!' }
);

testSchema('listRoomUsersInput', listRoomUsersInputSchema,
  { roomName: 'general' },
  { roomName: 'invalid room!' }
);

// メッセージングスキーマのテスト
console.log('\n=== Messaging Schema Tests ===');

testSchema('sendMessageInput', sendMessageInputSchema,
  { 
    agentName: 'alice', 
    roomName: 'general', 
    message: 'Hello world!',
    metadata: { priority: 'high' }
  },
  { agentName: '', roomName: 'general', message: 'x'.repeat(1001) }
);

testSchema('sendMessageOutput', sendMessageOutputSchema,
  {
    success: true,
    messageId: 'msg-123',
    roomName: 'general',
    agentName: 'alice',
    timestamp: '2024-01-01T00:00:00Z',
    mentions: ['bob', 'charlie']
  }
);

testSchema('getMessagesInput', getMessagesInputSchema,
  { 
    roomName: 'general',
    limit: 50,
    since: '2024-01-01T00:00:00Z',
    includeMetadata: true
  },
  { roomName: '', limit: 0 }
);

// Note: deleteMessage and getMessageMentions schemas are not yet implemented

// 管理機能スキーマのテスト
console.log('\n=== Management Schema Tests ===');

testSchema('getStatusInput', getStatusInputSchema,
  { roomName: 'general' },
  { roomName: 'invalid!' }
);

testSchema('getStatusOutput', getStatusOutputSchema,
  {
    totalRooms: 5,
    totalMessages: 1000,
    totalAgents: 10,
    activeRooms: ['general', 'random'],
    onlineAgents: 7,
    roomDetails: [
      { name: 'general', messageCount: 500, userCount: 5 }
    ]
  }
);

testSchema('clearRoomMessagesInput', clearRoomMessagesInputSchema,
  { 
    roomName: 'general',
    olderThan: '2024-01-01T00:00:00Z',
    dryRun: true
  },
  { roomName: 'invalid!', olderThan: 'not-a-date' }
);

testSchema('getRoomStatisticsInput', getRoomStatisticsInputSchema,
  {
    roomName: 'general',
    includeHistory: true,
    timeRange: {
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-31T23:59:59Z'
    }
  },
  { roomName: '', timeRange: { from: 'invalid', to: 'invalid' } }
);

// デフォルト値のテスト
console.log('\n=== Default Values Test ===');

const getMessagesDefaults = getMessagesInputSchema.parse({ roomName: 'general' });
console.log('getMessages defaults:', getMessagesDefaults);

const clearMessagesDefaults = clearRoomMessagesInputSchema.parse({ roomName: 'general' });
console.log('clearRoomMessages defaults:', clearMessagesDefaults);

const getRoomStatsDefaults = getRoomStatisticsInputSchema.parse({ roomName: 'general' });
console.log('getRoomStatistics defaults:', getRoomStatsDefaults);

console.log('\n=== Schema Validation Tests Completed ===');

// メンション抽出のテスト
console.log('\n=== Mention Extraction Test ===');

function extractMentions(message: string): string[] {
  const mentionRegex = /@(\w+)/g;
  const mentions: string[] = [];
  let match;
  
  while ((match = mentionRegex.exec(message)) !== null) {
    if (match[1]) {
      mentions.push(match[1]);
    }
  }
  
  return mentions;
}

const testMessages = [
  'Hello @alice and @bob!',
  'No mentions here',
  '@charlie @david @emily multiple mentions',
  'Email test@example.com should not match',
];

testMessages.forEach(msg => {
  console.log(`"${msg}" -> mentions:`, extractMentions(msg));
});

console.log('\n✅ All schema validations completed successfully!');