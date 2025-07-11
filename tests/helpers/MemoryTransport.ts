import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export class MemoryTransport implements Transport {
  private pendingRequests = new Map<number | string, (response: JSONRPCResponse) => void>();
  private connected = false;
  private _isClosed = false;
  
  // Properties that the MCP SDK sets
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  
  async start(): Promise<void> {
    this.connected = true;
    this._isClosed = false;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this._isClosed = false;
  }
  
  async close(): Promise<void> {
    if (this._isClosed) return;
    
    this.connected = false;
    this._isClosed = true;
    
    if (this.onclose) {
      this.onclose();
    }
  }
  
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.connected) {
      throw new Error('Transport is not connected');
    }
    
    // Debug: Log all messages
    if (process.env.DEBUG_TRANSPORT) {
      console.log('Transport.send:', JSON.stringify(message, null, 2));
    }
    
    // The server sends responses through this method
    // We'll capture them for our tests
    if ('result' in message || 'error' in message) {
      const response = message as JSONRPCResponse;
      const resolver = this.pendingRequests.get(response.id!);
      if (resolver) {
        resolver(response);
        this.pendingRequests.delete(response.id!);
      } else if (process.env.DEBUG_TRANSPORT) {
        console.log('No resolver found for response id:', response.id);
      }
    }
  }
  
  
  // For testing: simulate sending a request to the server
  async simulateRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    if (!this.onmessage) {
      throw new Error('No message handler registered');
    }
    
    return new Promise<JSONRPCResponse>((resolve, reject) => {
      // Store the resolver for this request
      this.pendingRequests.set(request.id!, resolve);
      
      // Set a timeout to avoid hanging tests
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(request.id!)) {
          this.pendingRequests.delete(request.id!);
          reject(new Error('Request timeout'));
        }
      }, 20000); // Match vitest timeout (20s)
      
      // Override the resolver to clear the timeout
      const originalResolve = resolve;
      this.pendingRequests.set(request.id!, (response) => {
        clearTimeout(timeoutId);
        originalResolve(response);
      });
      
      // Send the request to the server
      this.onmessage(request);
    });
  }
}