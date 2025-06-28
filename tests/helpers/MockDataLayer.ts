import { vi } from 'vitest';
import { Room, Agent, Message, RoomStats, SystemStats } from '../../src/types/index.js';

export class MockDataLayer {
  private rooms = new Map<string, Room>();
  private messages = new Map<string, Message[]>();
  private presence = new Map<string, Set<string>>();
  
  reset() {
    this.rooms.clear();
    this.messages.clear();
    this.presence.clear();
  }
  
  // Room methods
  roomExists(roomName: string): boolean {
    return this.rooms.has(roomName);
  }
  
  createRoom(room: Room): void {
    this.rooms.set(room.name, room);
    this.messages.set(room.name, []);
    this.presence.set(room.name, new Set());
  }
  
  getRoom(roomName: string): Room | undefined {
    return this.rooms.get(roomName);
  }
  
  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }
  
  deleteRoom(roomName: string): void {
    this.rooms.delete(roomName);
    this.messages.delete(roomName);
    this.presence.delete(roomName);
  }
  
  // Message methods
  addMessage(roomName: string, message: Message): void {
    const messages = this.messages.get(roomName) || [];
    messages.push(message);
    this.messages.set(roomName, messages);
  }
  
  getMessages(roomName: string, limit?: number, before?: string, offset?: number): Message[] {
    const messages = this.messages.get(roomName) || [];
    let result = [...messages];
    
    if (before) {
      const beforeIndex = result.findIndex(m => m.id === before);
      if (beforeIndex >= 0) {
        result = result.slice(0, beforeIndex);
      }
    }
    
    if (offset !== undefined && offset > 0) {
      result = result.slice(offset);
    }
    
    if (limit) {
      result = result.slice(0, limit);
    }
    
    return result;
  }
  
  clearMessages(roomName: string): number {
    const messages = this.messages.get(roomName) || [];
    const clearedCount = messages.length;
    this.messages.set(roomName, []);
    return clearedCount;
  }
  
  // Presence methods
  addAgentToRoom(roomName: string, agentName: string): void {
    const agents = this.presence.get(roomName) || new Set();
    agents.add(agentName);
    this.presence.set(roomName, agents);
  }
  
  removeAgentFromRoom(roomName: string, agentName: string): void {
    const agents = this.presence.get(roomName);
    if (agents) {
      agents.delete(agentName);
    }
  }
  
  getRoomAgents(roomName: string): string[] {
    const agents = this.presence.get(roomName) || new Set();
    return Array.from(agents);
  }
  
  // Stats methods
  getRoomStats(roomName: string): RoomStats {
    const room = this.rooms.get(roomName);
    const messages = this.messages.get(roomName) || [];
    const agents = this.presence.get(roomName) || new Set();
    
    return {
      roomName,
      createdAt: room?.createdAt || new Date().toISOString(),
      messageCount: messages.length,
      activeAgents: agents.size,
      lastActivity: messages.length > 0 ? messages[messages.length - 1].timestamp : room?.createdAt || new Date().toISOString()
    };
  }
  
  getSystemStats(): SystemStats {
    const totalMessages = Array.from(this.messages.values()).reduce((sum, msgs) => sum + msgs.length, 0);
    const totalAgents = new Set(Array.from(this.presence.values()).flatMap(agents => Array.from(agents))).size;
    
    return {
      totalRooms: this.rooms.size,
      totalMessages,
      activeAgents: totalAgents,
      uptime: Date.now(),
      serverVersion: '1.0.0'
    };
  }
}

export const createMockDataLayer = () => new MockDataLayer();