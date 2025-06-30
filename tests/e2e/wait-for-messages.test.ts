import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MemoryTransport } from '../helpers/MemoryTransport.js';
import { ToolRegistry } from '../../src/server/ToolRegistry.js';
import path from 'path';
import { promises as fs } from 'fs';

describe('Wait For Messages E2E Tests', () => {
  let server: Server;
  let transport: MemoryTransport;
  let toolRegistry: ToolRegistry;
  let testDataDir: string;
  
  beforeAll(async () => {
    // Create temporary test directory
    testDataDir = path.join(process.cwd(), 'e2e-wait-test-' + Date.now());
    await fs.mkdir(testDataDir, { recursive: true });
    
    // Set environment variable to use test directory
    process.env.AGENT_COMM_DATA_DIR = testDataDir;
    
    // Initialize real MCP server
    server = new Server({
      name: 'agent-communication',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {}
      }
    });
    
    transport = new MemoryTransport();
    toolRegistry = new ToolRegistry(testDataDir);
    
    // Connect server to transport
    await server.connect(transport);
    
    // Register all real tools
    await toolRegistry.registerAll(server);
  });
  
  afterAll(async () => {
    await transport.close();
    await toolRegistry.shutdown();
    
    // Clean up test directory
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    
    // Clean up environment variable
    delete process.env.AGENT_COMM_DATA_DIR;
  });
  
  beforeEach(async () => {
    // Clean data directory between tests
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(
        files.map(file => fs.rm(path.join(testDataDir, file), { recursive: true, force: true }))
      );
    } catch (error) {
      // Ignore if directory doesn't exist
    }
    
    // Ensure clean directory structure
    await fs.mkdir(path.join(testDataDir, 'rooms'), { recursive: true });
  });
  
  describe('Wait For Messages Basic Functionality', () => {
    it('should return immediately if messages are already available', async () => {
      // Setup: Create room and send messages
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'wait-test-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'sender', roomName: 'wait-test-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'waiter', roomName: 'wait-test-room' }
        }
      });
      
      // Send a message
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'sender',
            roomName: 'wait-test-room',
            message: 'Hello waiter!'
          }
        }
      });
      
      // Wait for messages should return immediately
      const startTime = Date.now();
      const waitResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'agent_communication_wait_for_messages',
          arguments: {
            agentName: 'waiter',
            roomName: 'wait-test-room',
            timeout: 5
          }
        }
      });
      const duration = Date.now() - startTime;
      
      expect(waitResponse.error).toBeUndefined();
      const result = JSON.parse(waitResponse.result!.content[0].text);
      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Hello waiter!');
      expect(duration).toBeLessThan(1000); // Should return almost immediately
    });
    
    it('should wait for new messages and return when they arrive', async () => {
      // Setup: Create room and join agents
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'wait-test-room-2' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'sender2', roomName: 'wait-test-room-2' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'waiter2', roomName: 'wait-test-room-2' }
        }
      });
      
      // Start waiting for messages (this will block)
      const waitPromise = transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_wait_for_messages',
          arguments: {
            agentName: 'waiter2',
            roomName: 'wait-test-room-2',
            timeout: 5
          }
        }
      });
      
      // Send a message after a short delay
      setTimeout(async () => {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'sender2',
              roomName: 'wait-test-room-2',
              message: 'New message arrived!'
            }
          }
        });
      }, 500);
      
      const startTime = Date.now();
      const waitResponse = await waitPromise;
      const duration = Date.now() - startTime;
      
      expect(waitResponse.error).toBeUndefined();
      const result = JSON.parse(waitResponse.result!.content[0].text);
      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('New message arrived!');
      expect(duration).toBeGreaterThanOrEqual(500);
      expect(duration).toBeLessThan(2000);
    });
    
    it('should timeout when no new messages arrive', async () => {
      // Setup: Create room and join
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'timeout-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'lonely-waiter', roomName: 'timeout-room' }
        }
      });
      
      // Wait for messages with short timeout
      const startTime = Date.now();
      const waitResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_wait_for_messages',
          arguments: {
            agentName: 'lonely-waiter',
            roomName: 'timeout-room',
            timeout: 2
          }
        }
      });
      const duration = Date.now() - startTime;
      
      expect(waitResponse.error).toBeUndefined();
      const result = JSON.parse(waitResponse.result!.content[0].text);
      expect(result.hasNewMessages).toBe(false);
      expect(result.messages).toHaveLength(0);
      expect(duration).toBeGreaterThanOrEqual(2000);
      expect(duration).toBeLessThan(3000);
    });
  });
  
  describe('Wait For Messages Concurrent Scenarios', () => {
    it('should handle multiple agents waiting simultaneously', async () => {
      // Setup: Create room
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'multi-wait-room' }
        }
      });
      
      // Join multiple agents
      const agents = ['waiter-1', 'waiter-2', 'waiter-3', 'sender'];
      for (let i = 0; i < agents.length; i++) {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: i + 10,
          method: 'tools/call',
          params: {
            name: 'agent_communication_enter_room',
            arguments: { agentName: agents[i], roomName: 'multi-wait-room' }
          }
        });
      }
      
      // Multiple agents start waiting
      const waitPromises = [];
      for (let i = 0; i < 3; i++) {
        waitPromises.push(
          transport.simulateRequest({
            jsonrpc: '2.0',
            id: i + 20,
            method: 'tools/call',
            params: {
              name: 'agent_communication_wait_for_messages',
              arguments: {
                agentName: agents[i],
                roomName: 'multi-wait-room',
                timeout: 5
              }
            }
          })
        );
      }
      
      // Send a message after delay
      setTimeout(async () => {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 30,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'sender',
              roomName: 'multi-wait-room',
              message: 'Wake up everyone!'
            }
          }
        });
      }, 1000);
      
      // All waiters should receive the notification
      const results = await Promise.all(waitPromises);
      
      results.forEach(response => {
        expect(response.error).toBeUndefined();
        const result = JSON.parse(response.result!.content[0].text);
        expect(result.hasNewMessages).toBe(true);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].message).toBe('Wake up everyone!');
      });
    });
    
    it('should track read status correctly across multiple wait calls', async () => {
      // Setup: Create room and join agents
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'timing-test-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'timing-sender', roomName: 'timing-test-room' }
        }
      });
      
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'agent_communication_enter_room',
          arguments: { agentName: 'timing-waiter', roomName: 'timing-test-room' }
        }
      });
      
      // Send first message
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'agent_communication_send_message',
          arguments: {
            agentName: 'timing-sender',
            roomName: 'timing-test-room',
            message: 'First message'
          }
        }
      });
      
      // First wait_for_messages call should return the first message
      const firstWaitResponse = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'agent_communication_wait_for_messages',
          arguments: {
            agentName: 'timing-waiter',
            roomName: 'timing-test-room',
            timeout: 1
          }
        }
      });
      
      expect(firstWaitResponse.error).toBeUndefined();
      const firstResult = JSON.parse(firstWaitResponse.result!.content[0].text);
      expect(firstResult.hasNewMessages).toBe(true);
      expect(firstResult.messages).toHaveLength(1);
      expect(firstResult.messages[0].message).toBe('First message');
      
      // Second wait_for_messages call with new message
      const waitPromise = transport.simulateRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'agent_communication_wait_for_messages',
          arguments: {
            agentName: 'timing-waiter',
            roomName: 'timing-test-room',
            timeout: 3
          }
        }
      });
      
      // Send new message after delay
      setTimeout(async () => {
        await transport.simulateRequest({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'agent_communication_send_message',
            arguments: {
              agentName: 'timing-sender',
              roomName: 'timing-test-room',
              message: 'Second message'
            }
          }
        });
      }, 1000);
      
      const startTime = Date.now();
      const waitResponse = await waitPromise;
      const duration = Date.now() - startTime;
      
      expect(waitResponse.error).toBeUndefined();
      const result = JSON.parse(waitResponse.result!.content[0].text);
      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1); // Only the new message
      expect(result.messages[0].message).toBe('Second message');
      expect(duration).toBeGreaterThanOrEqual(1000);
      expect(duration).toBeLessThan(2000);
    });
  });
  
  describe('Wait For Messages Error Handling', () => {
    it('should handle room not found error', async () => {
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_wait_for_messages',
          arguments: {
            agentName: 'lost-agent',
            roomName: 'non-existent-room',
            timeout: 1
          }
        }
      });
      
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toContain('not found');
    });
    
    it('should handle agent not in room error', async () => {
      // Create room but don't join
      await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'agent_communication_create_room',
          arguments: { roomName: 'restricted-wait-room' }
        }
      });
      
      const response = await transport.simulateRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agent_communication_wait_for_messages',
          arguments: {
            agentName: 'outsider',
            roomName: 'restricted-wait-room',
            timeout: 1
          }
        }
      });
      
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toContain('not in room');
    });
  });
});