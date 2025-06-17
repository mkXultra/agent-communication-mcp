import { MessageListResponse, GetMessagesParams } from './types/messaging.types';

interface CacheNode {
  key: string;
  value: MessageListResponse;
  prev?: CacheNode;
  next?: CacheNode;
}

export class MessageCache {
  private capacity: number;
  private cache: Map<string, CacheNode>;
  private head: CacheNode;
  private tail: CacheNode;

  constructor(capacity: number = 1000) {
    this.capacity = capacity;
    this.cache = new Map();
    
    // Create dummy head and tail nodes for easier LRU management
    this.head = { key: '', value: {} as MessageListResponse };
    this.tail = { key: '', value: {} as MessageListResponse };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Generate cache key from get messages parameters
   */
  private generateCacheKey(params: GetMessagesParams): string {
    const { roomName, limit = 50, offset = 0, mentionsOnly = false, agentName = '' } = params;
    return `${roomName}:${limit}:${offset}:${mentionsOnly}:${agentName}`;
  }

  /**
   * Validate cache entry data
   */
  private isValidCacheEntry(data: any): data is MessageListResponse {
    return data && 
           typeof data === 'object' &&
           typeof data.roomName === 'string' &&
           data.roomName.length > 0 &&
           Array.isArray(data.messages) &&
           typeof data.count === 'number' &&
           typeof data.hasMore === 'boolean';
  }

  /**
   * Move node to head (mark as most recently used)
   */
  private moveToHead(node: CacheNode): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  /**
   * Remove node from doubly linked list
   */
  private removeNode(node: CacheNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
  }

  /**
   * Add node right after head
   */
  private addToHead(node: CacheNode): void {
    node.prev = this.head;
    node.next = this.head.next;
    
    if (this.head.next) {
      this.head.next.prev = node;
    }
    this.head.next = node;
  }

  /**
   * Remove tail node (least recently used)
   */
  private removeTail(): CacheNode | undefined {
    const lastNode = this.tail.prev;
    if (lastNode && lastNode !== this.head) {
      this.removeNode(lastNode);
      return lastNode;
    }
    return undefined;
  }

  /**
   * Get cached response by parameters
   */
  get(params: GetMessagesParams): MessageListResponse | undefined;
  get(key: string): MessageListResponse | undefined;
  get(paramsOrKey: GetMessagesParams | string): MessageListResponse | undefined {
    const key = typeof paramsOrKey === 'string' ? paramsOrKey : this.generateCacheKey(paramsOrKey);
    
    const node = this.cache.get(key);
    if (!node) {
      return undefined;
    }

    // Validate cached data
    if (!this.isValidCacheEntry(node.value)) {
      this.cache.delete(key);
      this.removeNode(node);
      return undefined;
    }

    // Move to head (mark as recently used)
    this.moveToHead(node);
    return node.value;
  }

  /**
   * Cache response with parameters or key
   */
  set(params: GetMessagesParams, value: MessageListResponse): void;
  set(key: string, value: MessageListResponse): void;
  set(paramsOrKey: GetMessagesParams | string, value: MessageListResponse): void {
    const key = typeof paramsOrKey === 'string' ? paramsOrKey : this.generateCacheKey(paramsOrKey);
    
    // Validate response before caching
    if (!this.isValidCacheEntry(value)) {
      return;
    }

    const existingNode = this.cache.get(key);
    
    if (existingNode) {
      // Update existing entry
      existingNode.value = value;
      this.moveToHead(existingNode);
    } else {
      // Add new entry
      const newNode: CacheNode = { key, value };
      
      if (this.cache.size >= this.capacity) {
        // Evict least recently used
        const tail = this.removeTail();
        if (tail) {
          this.cache.delete(tail.key);
        }
      }
      
      this.cache.set(key, newNode);
      this.addToHead(newNode);
    }
  }

  /**
   * Check if key exists in cache
   */
  has(params: GetMessagesParams): boolean;
  has(key: string): boolean;
  has(paramsOrKey: GetMessagesParams | string): boolean {
    const key = typeof paramsOrKey === 'string' ? paramsOrKey : this.generateCacheKey(paramsOrKey);
    return this.cache.has(key);
  }

  /**
   * Delete specific cache entry
   */
  delete(params: GetMessagesParams): boolean;
  delete(key: string): boolean;
  delete(paramsOrKey: GetMessagesParams | string): boolean {
    const key = typeof paramsOrKey === 'string' ? paramsOrKey : this.generateCacheKey(paramsOrKey);
    
    const node = this.cache.get(key);
    if (!node) {
      return false;
    }

    this.cache.delete(key);
    this.removeNode(node);
    return true;
  }

  /**
   * Clear entire cache or room-specific cache
   */
  clear(roomName?: string): void {
    if (!roomName) {
      // Clear entire cache
      this.cache.clear();
      this.head.next = this.tail;
      this.tail.prev = this.head;
    } else {
      // Clear room-specific cache entries
      const keysToDelete: string[] = [];
      
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${roomName}:`)) {
          keysToDelete.push(key);
        }
      }
      
      keysToDelete.forEach(key => {
        const node = this.cache.get(key);
        if (node) {
          this.cache.delete(key);
          this.removeNode(node);
        }
      });
    }
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache capacity
   */
  get cacheCapacity(): number {
    return this.capacity;
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; capacity: number; hitRatio?: number } {
    return {
      size: this.size,
      capacity: this.capacity
    };
  }
}