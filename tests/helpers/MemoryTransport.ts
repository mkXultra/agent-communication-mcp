import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';

export class MemoryTransport implements Transport {
  private handlers = new Map<string, (request: JSONRPCRequest) => Promise<JSONRPCResponse>>();
  private notificationHandlers = new Map<string, (notification: JSONRPCNotification) => void>();
  private onCloseHandler?: () => void;
  private onErrorHandler?: (error: Error) => void;
  private connected = false;
  private _isClosed = false;
  
  async connect(): Promise<void> {
    this.connected = true;
    this._isClosed = false;
  }
  
  async close(): Promise<void> {
    if (this._isClosed) return;
    
    this.connected = false;
    this._isClosed = true;
    
    if (this.onCloseHandler) {
      this.onCloseHandler();
    }
  }
  
  async send(message: JSONRPCRequest): Promise<JSONRPCResponse> {
    if (!this.connected) {
      throw new Error('Transport is not connected');
    }
    
    const handler = this.handlers.get(message.method);
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Method not found: ${message.method}`
        }
      };
    }
    
    try {
      return await handler(message);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error'
        }
      };
    }
  }
  
  onMessage(handler: (message: JSONRPCRequest) => Promise<JSONRPCResponse>): void {
    // This is used by the server to handle incoming requests
    this.defaultHandler = handler;
  }
  
  private defaultHandler?: (message: JSONRPCRequest) => Promise<JSONRPCResponse>;
  
  // For testing: simulate sending a request to the server
  async simulateRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    if (!this.defaultHandler) {
      throw new Error('No message handler registered');
    }
    return this.defaultHandler(request);
  }
  
  onClose(handler: () => void): void {
    this.onCloseHandler = handler;
  }
  
  onError(handler: (error: Error) => void): void {
    this.onErrorHandler = handler;
  }
}