const { beforeAll, afterAll, describe, it, expect } = require('vitest');
const { MCPTestTransport } = require('./tests/utils/MCPTestTransport');
const { TestStateManager } = require('./tests/utils/TestStateManager');

describe('Debug clearRoomMessages', () => {
  let transport;
  let stateManager;
  
  beforeAll(async () => {
    stateManager = new TestStateManager();
    await stateManager.initialize();
    
    transport = new MCPTestTransport(stateManager);
    await transport.initialize();
  });
  
  afterAll(async () => {
    await stateManager.cleanup();
  });
  
  it('should check clearRoomMessages response format', async () => {
    // Create room
    await transport.simulateRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'agent_communication_create_room',
        arguments: { roomName: 'debug-room' }
      }
    });
    
    // Clear messages
    const response = await transport.simulateRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'agent_communication_clear_room_messages',
        arguments: { roomName: 'debug-room', confirm: true }
      }
    });
    
    console.log('Full response:', JSON.stringify(response, null, 2));
    
    if (response.result && response.result.content) {
      console.log('Result content:', response.result.content);
      if (response.result.content[0] && response.result.content[0].text) {
        console.log('Text content:', response.result.content[0].text);
        try {
          const parsed = JSON.parse(response.result.content[0].text);
          console.log('Parsed content:', parsed);
        } catch (e) {
          console.log('Failed to parse:', e);
        }
      }
    }
  });
});

