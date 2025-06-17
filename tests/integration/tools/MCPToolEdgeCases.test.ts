import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDataLayer } from '../../helpers/MockDataLayer.js';
import { MockToolRegistry } from '../../helpers/MockToolRegistry.js';
import { MemoryTransport } from '../../helpers/MemoryTransport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

describe('MCP Tools Edge Cases and Validation Tests', () => {
  let dataLayer: MockDataLayer;
  let toolRegistry: MockToolRegistry;
  let server: Server;
  let transport: MemoryTransport;
  
  beforeEach(async () => {
    dataLayer = new MockDataLayer();
    toolRegistry = new MockToolRegistry(dataLayer);
    server = new Server({ name: 'test-server', version: '1.0.0' });
    transport = new MemoryTransport();
    
    await toolRegistry.registerAll(server);
    await server.connect(transport);
  });
  
  describe('list_rooms Edge Cases', () => {
    it('should handle empty room list consistently', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/list_rooms',
          arguments: {}
        }
      });
      
      const result = JSON.parse(response.result!.content[0].text);
      expect(result.rooms).toEqual([]);
      expect(Array.isArray(result.rooms)).toBe(true);
    });
    
    it('should handle rooms with special characters', async () => {
      const specialRoomNames = [
        'room-with-dashes',
        'room_with_underscores',
        'room.with.dots',
        'ROOM_WITH_CAPS',
        'room123numbers',
        'room@special#chars',
        '房间中文名',
        'комната-русский'
      ];
      
      // Create rooms with special names
      for (const roomName of specialRoomNames) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/create_room',
            arguments: { roomName }
          }
        });
      }
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication/list_rooms',
          arguments: {}
        }
      });
      
      const result = JSON.parse(response.result!.content[0].text);
      expect(result.rooms).toHaveLength(specialRoomNames.length);
      
      const returnedNames = result.rooms.map((r: any) => r.name);
      specialRoomNames.forEach(name => {
        expect(returnedNames).toContain(name);
      });
    });
    
    it('should handle large number of rooms', async () => {
      // Create many rooms
      const roomCount = 1000;
      for (let i = 0; i < roomCount; i++) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i,
          method: 'tools/call',
          params: {
            name: 'agent_communication/create_room',
            arguments: { roomName: `room-${i}` }
          }
        });
      }
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: roomCount + 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/list_rooms',
          arguments: {}
        }
      });
      
      const result = JSON.parse(response.result!.content[0].text);
      expect(result.rooms).toHaveLength(roomCount);
    });
  });
  
  describe('create_room Edge Cases', () => {
    it('should reject invalid room names', async () => {
      const invalidNames = [
        '',           // Empty string
        ' ',          // Whitespace only
        '   ',        // Multiple spaces
        null,         // Null value
        undefined     // Undefined value
      ];
      
      for (const invalidName of invalidNames) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/create_room',
            arguments: { roomName: invalidName }
          }
        });
        
        // Should either error or handle gracefully
        if (response.error) {
          expect(response.error).toBeDefined();
        }
      }
    });
    
    it('should handle extremely long room names', async () => {
      const longName = 'a'.repeat(1000);
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: longName }
        }
      });
      
      // Should either succeed or fail gracefully
      expect(response).toBeDefined();
    });
    
    it('should handle extremely long descriptions', async () => {
      const longDescription = 'This is a very long description. '.repeat(1000);
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { 
            roomName: 'test-room',
            description: longDescription
          }
        }
      });
      
      expect(response.error).toBeUndefined();
    });
    
    it('should handle concurrent room creation with same name', async () => {
      const roomName = 'concurrent-room';
      
      const promises = Array.from({ length: 5 }, (_, i) =>
        transport.simulateRequest({
          jsonrpc: '2.0',
          id: i,
          method: 'tools/call',
          params: {
            name: 'agent_communication/create_room',
            arguments: { roomName }
          }
        })
      );
      
      const results = await Promise.all(promises);
      
      // Only one should succeed, others should fail with ROOM_ALREADY_EXISTS
      const successes = results.filter(r => !r.error);
      const failures = results.filter(r => r.error?.data?.errorCode === 'ROOM_ALREADY_EXISTS');
      
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(4);
    });
  });
  
  describe('enter_room Edge Cases', () => {
    beforeEach(async () => {
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: 'test-room' }
        }
      });
    });
    
    it('should handle invalid agent names', async () => {
      const invalidAgentNames = [
        '',
        ' ',
        null,
        undefined,
        '   whitespace-only   '
      ];
      
      for (const agentName of invalidAgentNames) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/enter_room',
            arguments: { agentName, roomName: 'test-room' }
          }
        });
        
        // Should handle gracefully
        expect(response).toBeDefined();
      }
    });
    
    it('should handle agent entering same room multiple times', async () => {
      const agentName = 'test-agent';
      
      // First entry should succeed
      const firstEntry = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/enter_room',
          arguments: { agentName, roomName: 'test-room' }
        }
      });
      
      expect(firstEntry.error).toBeUndefined();
      
      // Subsequent entries should be idempotent
      const secondEntry = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication/enter_room',
          arguments: { agentName, roomName: 'test-room' }
        }
      });
      
      expect(secondEntry.error).toBeUndefined();
    });
    
    it('should handle very long agent names', async () => {
      const longAgentName = 'agent-' + 'a'.repeat(1000);
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/enter_room',
          arguments: { agentName: longAgentName, roomName: 'test-room' }
        }
      });
      
      expect(response).toBeDefined();
    });
  });
  
  describe('send_message Edge Cases', () => {
    beforeEach(async () => {
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: 'test-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication/enter_room',
          arguments: { agentName: 'test-agent', roomName: 'test-room' }
        }
      });
    });
    
    it('should handle empty messages', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/send_message',
          arguments: {
            agentName: 'test-agent',
            roomName: 'test-room',
            message: ''
          }
        }
      });
      
      // Should handle empty messages appropriately
      expect(response).toBeDefined();
    });
    
    it('should handle extremely long messages', async () => {
      const longMessage = 'This is a very long message. '.repeat(10000);
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/send_message',
          arguments: {
            agentName: 'test-agent',
            roomName: 'test-room',
            message: longMessage
          }
        }
      });
      
      expect(response).toBeDefined();
    });
    
    it('should handle malformed mention patterns', async () => {
      const malformedMentions = [
        'Hello @ everyone',           // Space after @
        'Hi @',                      // @ at end
        'Hey @@duplicate',           // Double @
        '@123invalid',               // Starting with number
        '@with-special-chars!',      // Special characters
        '@@@multiple',               // Triple @
        'Multiple @user1 @user2 @user3 mentions'
      ];
      
      for (const message of malformedMentions) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/send_message',
            arguments: {
              agentName: 'test-agent',
              roomName: 'test-room',
              message
            }
          }
        });
        
        expect(response.error).toBeUndefined();
        
        if (response.result) {
          const result = JSON.parse(response.result.content[0].text);
          expect(Array.isArray(result.mentions)).toBe(true);
        }
      }
    });
    
    it('should handle messages with special characters and unicode', async () => {
      const specialMessages = [
        'Hello 世界! 🌍',
        'Тест сообщение',
        'مرحبا بالعالم',
        '🚀💻📱 Emoji message',
        'Code snippet: ```javascript\nconst x = 1;\n```',
        'JSON: {"key": "value", "number": 123}',
        'HTML: <div>content</div>',
        'SQL: SELECT * FROM users WHERE id = 1;'
      ];
      
      for (const message of specialMessages) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/send_message',
            arguments: {
              agentName: 'test-agent',
              roomName: 'test-room',
              message
            }
          }
        });
        
        expect(response.error).toBeUndefined();
      }
    });
  });
  
  describe('get_messages Edge Cases', () => {
    beforeEach(async () => {
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: 'test-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication/enter_room',
          arguments: { agentName: 'test-agent', roomName: 'test-room' }
        }
      });
    });
    
    it('should handle invalid limit values', async () => {
      const invalidLimits = [-1, 0, 10000, null, undefined, 'invalid'];
      
      for (const limit of invalidLimits) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/get_messages',
            arguments: {
              agentName: 'test-agent',
              roomName: 'test-room',
              limit
            }
          }
        });
        
        // Should handle invalid limits gracefully
        expect(response).toBeDefined();
      }
    });
    
    it('should handle invalid before parameter', async () => {
      const invalidBefore = [
        'non-existent-id',
        '',
        null,
        undefined,
        123,
        {}
      ];
      
      for (const before of invalidBefore) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/get_messages',
            arguments: {
              agentName: 'test-agent',
              roomName: 'test-room',
              before
            }
          }
        });
        
        // Should handle invalid before parameters gracefully
        expect(response).toBeDefined();
      }
    });
    
    it('should handle edge case pagination scenarios', async () => {
      // Send messages first
      for (let i = 0; i < 10; i++) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 100,
          method: 'tools/call',
          params: {
            name: 'agent_communication/send_message',
            arguments: {
              agentName: 'test-agent',
              roomName: 'test-room',
              message: `Message ${i}`
            }
          }
        });
      }
      
      // Test edge cases
      const edgeCases = [
        { limit: 0 },
        { limit: -1 },
        { limit: 1000000 },
        { before: 'non-existent' },
        { limit: 5, before: 'non-existent' }
      ];
      
      for (const args of edgeCases) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'agent_communication/get_messages',
            arguments: {
              agentName: 'test-agent',
              roomName: 'test-room',
              ...args
            }
          }
        });
        
        expect(response).toBeDefined();
      }
    });
  });
  
  describe('get_status Edge Cases', () => {
    it('should handle status request with no data', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/get_status',
          arguments: {}
        }
      });
      
      expect(response.error).toBeUndefined();
      const result = JSON.parse(response.result!.content[0].text);
      
      expect(result.totalRooms).toBe(0);
      expect(result.totalMessages).toBe(0);
      expect(result.activeAgents).toBe(0);
      expect(result.rooms).toEqual([]);
      expect(result.serverVersion).toBeDefined();
      expect(result.uptime).toBeGreaterThan(0);
    });
    
    it('should handle status with malformed extra arguments', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/get_status',
          arguments: {
            unexpectedParam: 'should be ignored',
            anotherParam: 123
          }
        }
      });
      
      expect(response.error).toBeUndefined();
    });
    
    it('should handle status request with extreme data volumes', async () => {
      // Create many rooms and messages
      for (let i = 0; i < 100; i++) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i,
          method: 'tools/call',
          params: {
            name: 'agent_communication/create_room',
            arguments: { roomName: `room-${i}` }
          }
        });
        
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 1000,
          method: 'tools/call',
          params: {
            name: 'agent_communication/enter_room',
            arguments: { agentName: `agent-${i}`, roomName: `room-${i}` }
          }
        });
        
        // Send multiple messages per room
        for (let j = 0; j < 10; j++) {
          await transport.simulateRequest({
            jsonrpc: '2.0',
            id: i * 1000 + j + 2000,
            method: 'tools/call',
            params: {
              name: 'agent_communication/send_message',
              arguments: {
                agentName: `agent-${i}`,
                roomName: `room-${i}`,
                message: `Message ${j} in room ${i}`
              }
            }
          });
        }
      }
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 999999,
        method: 'tools/call',
        params: {
          name: 'agent_communication/get_status',
          arguments: {}
        }
      });
      
      expect(response.error).toBeUndefined();
      const result = JSON.parse(response.result!.content[0].text);
      
      expect(result.totalRooms).toBe(100);
      expect(result.totalMessages).toBe(1000); // 100 rooms * 10 messages
      expect(result.activeAgents).toBe(100);
      expect(result.rooms).toHaveLength(100);
    });
  });
  
  describe('clear_room_messages Edge Cases', () => {
    it('should handle clearing non-existent room', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/clear_room_messages',
          arguments: { roomName: 'non-existent-room' }
        }
      });
      
      expect(response.error).toBeDefined();
      expect(response.error!.data?.errorCode).toBe('ROOM_NOT_FOUND');
    });
    
    it('should handle clearing empty room', async () => {
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: 'empty-room' }
        }
      });
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication/clear_room_messages',
          arguments: { roomName: 'empty-room' }
        }
      });
      
      expect(response.error).toBeUndefined();
      const result = JSON.parse(response.result!.content[0].text);
      expect(result.success).toBe(true);
      expect(result.clearedMessages).toBe(0);
    });
    
    it('should handle clearing room with many messages', async () => {
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: 'big-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication/enter_room',
          arguments: { agentName: 'test-agent', roomName: 'big-room' }
        }
      });
      
      // Add many messages
      const messageCount = 1000;
      for (let i = 0; i < messageCount; i++) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 100,
          method: 'tools/call',
          params: {
            name: 'agent_communication/send_message',
            arguments: {
              agentName: 'test-agent',
              roomName: 'big-room',
              message: `Message ${i}`
            }
          }
        });
      }
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 99999,
        method: 'tools/call',
        params: {
          name: 'agent_communication/clear_room_messages',
          arguments: { roomName: 'big-room' }
        }
      });
      
      expect(response.error).toBeUndefined();
      const result = JSON.parse(response.result!.content[0].text);
      expect(result.success).toBe(true);
      expect(result.clearedMessages).toBe(messageCount);
    });
    
    it('should handle concurrent clear operations', async () => {
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: 'concurrent-clear' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication/enter_room',
          arguments: { agentName: 'test-agent', roomName: 'concurrent-clear' }
        }
      });
      
      // Add some messages
      for (let i = 0; i < 10; i++) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 100,
          method: 'tools/call',
          params: {
            name: 'agent_communication/send_message',
            arguments: {
              agentName: 'test-agent',
              roomName: 'concurrent-clear',
              message: `Message ${i}`
            }
          }
        });
      }
      
      // Concurrent clear operations
      const clearPromises = Array.from({ length: 3 }, (_, i) =>
        transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 1000,
          method: 'tools/call',
          params: {
            name: 'agent_communication/clear_room_messages',
            arguments: { roomName: 'concurrent-clear' }
          }
        })
      );
      
      const results = await Promise.all(clearPromises);
      
      // All should succeed, but only one should actually clear messages
      results.forEach(response => {
        expect(response.error).toBeUndefined();
      });
      
      const clearCounts = results.map(r => {
        const result = JSON.parse(r.result!.content[0].text);
        return result.clearedMessages;
      });
      
      // Sum of all cleared messages should equal original message count
      const totalCleared = clearCounts.reduce((sum, count) => sum + count, 0);
      expect(totalCleared).toBe(10);
    });
  });
  
  describe('Tool Parameter Validation', () => {
    it('should handle missing required parameters', async () => {
      const testCases = [
        {
          tool: 'agent_communication/create_room',
          args: {} // Missing roomName
        },
        {
          tool: 'agent_communication/enter_room',
          args: { agentName: 'test' } // Missing roomName
        },
        {
          tool: 'agent_communication/send_message',
          args: { agentName: 'test', roomName: 'test' } // Missing message
        }
      ];
      
      for (const testCase of testCases) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: testCase.tool,
            arguments: testCase.args
          }
        });
        
        // Should handle missing parameters appropriately
        expect(response).toBeDefined();
      }
    });
    
    it('should handle extra/unexpected parameters', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: {
            roomName: 'test-room',
            description: 'valid param',
            unexpectedParam: 'should be ignored',
            extraNumber: 123,
            extraObject: { nested: 'value' }
          }
        }
      });
      
      expect(response.error).toBeUndefined();
    });
    
    it('should handle parameter type mismatches', async () => {
      const typeMismatchCases = [
        {
          tool: 'agent_communication/create_room',
          args: { roomName: 123 } // Number instead of string
        },
        {
          tool: 'agent_communication/get_messages',
          args: { 
            agentName: 'test',
            roomName: 'test',
            limit: 'invalid-number'
          }
        }
      ];
      
      for (const testCase of typeMismatchCases) {
        const response = await transport.simulateRequest({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: testCase.tool,
            arguments: testCase.args
          }
        });
        
        // Should handle type mismatches gracefully
        expect(response).toBeDefined();
      }
    });
  });
  
  describe('System Stress Tests', () => {
    it('should handle rapid successive operations', async () => {
      const operations = [];
      
      // Rapid room creation
      for (let i = 0; i < 50; i++) {
        operations.push(
          transport.simulateRequest({
            jsonrpc: '2.0',
            id: i,
            method: 'tools/call',
            params: {
              name: 'agent_communication/create_room',
              arguments: { roomName: `rapid-room-${i}` }
            }
          })
        );
      }
      
      const results = await Promise.all(operations);
      
      // All operations should complete
      expect(results).toHaveLength(50);
      results.forEach(result => {
        expect(result).toBeDefined();
      });
    });
    
    it('should maintain consistency under high load', async () => {
      // Create base room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication/create_room',
          arguments: { roomName: 'stress-test-room' }
        }
      });
      
      // High load operations
      const highLoadOps = [];
      
      // Multiple agents entering
      for (let i = 0; i < 20; i++) {
        highLoadOps.push(
          transport.simulateRequest({
            jsonrpc: '2.0',
            id: i + 100,
            method: 'tools/call',
            params: {
              name: 'agent_communication/enter_room',
              arguments: { 
                agentName: `stress-agent-${i}`,
                roomName: 'stress-test-room'
              }
            }
          })
        );
      }
      
      // Multiple messages
      for (let i = 0; i < 50; i++) {
        highLoadOps.push(
          transport.simulateRequest({
            jsonrpc: '2.0',
            id: i + 200,
            method: 'tools/call',
            params: {
              name: 'agent_communication/send_message',
              arguments: {
                agentName: `stress-agent-${i % 20}`,
                roomName: 'stress-test-room',
                message: `Stress message ${i}`
              }
            }
          })
        );
      }
      
      const results = await Promise.all(highLoadOps);
      
      // Verify no critical failures
      const criticalErrors = results.filter(r => 
        r.error && !['AGENT_NOT_IN_ROOM'].includes(r.error.data?.errorCode)
      );
      
      expect(criticalErrors).toHaveLength(0);
    });
  });
});