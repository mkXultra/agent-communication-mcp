import { describe, it, expect, beforeEach } from 'vitest';
import { MessageCache } from '../../../src/features/messaging/MessageCache';
import type { MessageListResponse, GetMessagesParams } from '../../../src/features/messaging';

describe('MessageCache', () => {
  let cache: MessageCache;
  const maxCacheSize = 1000;

  beforeEach(() => {
    cache = new MessageCache(maxCacheSize);
  });

  describe('cache key generation', () => {
    it('should generate consistent cache keys', () => {
      const params1: GetMessagesParams = {
        roomName: 'general',
        limit: 50,
        offset: 0,
        mentionsOnly: false
      };

      const params2: GetMessagesParams = {
        roomName: 'general',
        limit: 20,
        offset: 10,
        mentionsOnly: true,
        agentName: 'agent1'
      };

      // Test cache operations with parameters
      const response1: MessageListResponse = {
        roomName: 'general',
        messages: [],
        count: 0,
        hasMore: false
      };

      const response2: MessageListResponse = {
        roomName: 'general',
        messages: [],
        count: 0,
        hasMore: false
      };

      cache.set(params1, response1);
      cache.set(params2, response2);

      expect(cache.get(params1)).toEqual(response1);
      expect(cache.get(params2)).toEqual(response2);
    });

    it('should handle string keys', () => {
      const key = 'general:50:0:false:';
      const response: MessageListResponse = {
        roomName: 'general',
        messages: [],
        count: 0,
        hasMore: false
      };

      cache.set(key, response);
      expect(cache.get(key)).toEqual(response);
    });
  });

  describe('get and set operations', () => {
    it('should retrieve cached messages', () => {
      const params: GetMessagesParams = {
        roomName: 'general',
        limit: 50,
        offset: 0,
        mentionsOnly: false
      };

      const cachedResponse: MessageListResponse = {
        roomName: 'general',
        messages: [
          {
            id: '1',
            agentName: 'agent1',
            roomName: 'general',
            message: 'Hello',
            timestamp: '2024-01-01T10:00:00.000Z',
            mentions: [],
            metadata: {}
          }
        ],
        count: 1,
        hasMore: false
      };

      cache.set(params, cachedResponse);
      const result = cache.get(params);
      expect(result).toEqual(cachedResponse);
    });

    it('should return undefined for cache miss', () => {
      const params: GetMessagesParams = {
        roomName: 'nonexistent',
        limit: 50,
        offset: 0,
        mentionsOnly: false
      };

      const result = cache.get(params);
      expect(result).toBeUndefined();
    });

    it('should not cache invalid responses', () => {
      const params: GetMessagesParams = {
        roomName: 'general',
        limit: 50,
        offset: 0,
        mentionsOnly: false
      };

      // Try to cache invalid response
      cache.set(params, { roomName: '', messages: null } as any);
      
      const result = cache.get(params);
      expect(result).toBeUndefined();
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used items when at capacity', () => {
      const smallCache = new MessageCache(3); // Small capacity for testing
      
      const response: MessageListResponse = {
        roomName: 'test',
        messages: [],
        count: 0,
        hasMore: false
      };

      // Fill cache to capacity
      smallCache.set('key1', response);
      smallCache.set('key2', response);
      smallCache.set('key3', response);

      expect(smallCache.size).toBe(3);

      // Add one more item - should evict the LRU (key1)
      smallCache.set('key4', response);

      expect(smallCache.size).toBe(3);
      expect(smallCache.get('key1')).toBeUndefined(); // Should be evicted
      expect(smallCache.get('key2')).toEqual(response);
      expect(smallCache.get('key3')).toEqual(response);
      expect(smallCache.get('key4')).toEqual(response);
    });

    it('should update LRU order on access', () => {
      const smallCache = new MessageCache(3);
      
      const response: MessageListResponse = {
        roomName: 'test',
        messages: [],
        count: 0,
        hasMore: false
      };

      // Fill cache
      smallCache.set('key1', response);
      smallCache.set('key2', response);
      smallCache.set('key3', response);

      // Access key1 to make it most recently used
      smallCache.get('key1');

      // Add new item - should evict key2 (least recently used)
      smallCache.set('key4', response);

      expect(smallCache.get('key1')).toEqual(response); // Should still exist
      expect(smallCache.get('key2')).toBeUndefined(); // Should be evicted
      expect(smallCache.get('key3')).toEqual(response);
      expect(smallCache.get('key4')).toEqual(response);
    });
  });

  describe('cache operations', () => {
    it('should support has operation', () => {
      const params: GetMessagesParams = {
        roomName: 'general',
        limit: 50,
        offset: 0,
        mentionsOnly: false
      };

      const response: MessageListResponse = {
        roomName: 'general',
        messages: [],
        count: 0,
        hasMore: false
      };

      expect(cache.has(params)).toBe(false);
      
      cache.set(params, response);
      expect(cache.has(params)).toBe(true);
    });

    it('should support delete operation', () => {
      const params: GetMessagesParams = {
        roomName: 'general',
        limit: 50,
        offset: 0,
        mentionsOnly: false
      };

      const response: MessageListResponse = {
        roomName: 'general',
        messages: [],
        count: 0,
        hasMore: false
      };

      cache.set(params, response);
      expect(cache.has(params)).toBe(true);

      const deleted = cache.delete(params);
      expect(deleted).toBe(true);
      expect(cache.has(params)).toBe(false);
    });

    it('should return false for delete of non-existent key', () => {
      const params: GetMessagesParams = {
        roomName: 'nonexistent',
        limit: 50,
        offset: 0,
        mentionsOnly: false
      };

      const deleted = cache.delete(params);
      expect(deleted).toBe(false);
    });
  });

  describe('clear operations', () => {
    it('should clear entire cache', () => {
      const response: MessageListResponse = {
        roomName: 'test',
        messages: [],
        count: 0,
        hasMore: false
      };

      cache.set('key1', response);
      cache.set('key2', response);
      cache.set('key3', response);

      expect(cache.size).toBe(3);

      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should clear cache for specific room', () => {
      const response: MessageListResponse = {
        roomName: 'test',
        messages: [],
        count: 0,
        hasMore: false
      };

      // Add entries for multiple rooms
      cache.set('general:50:0:false:', response);
      cache.set('general:20:10:true:agent1', response);
      cache.set('general:100:0:false:', response);
      cache.set('dev-team:50:0:false:', response);

      expect(cache.size).toBe(4);

      // Clear only general room cache
      cache.clear('general');

      expect(cache.size).toBe(1);
      expect(cache.get('dev-team:50:0:false:')).toEqual(response);
      expect(cache.get('general:50:0:false:')).toBeUndefined();
    });
  });

  describe('mentionsOnly optimization', () => {
    it('should cache mentionsOnly queries separately', () => {
      const baseParams: GetMessagesParams = {
        roomName: 'general',
        limit: 50,
        offset: 0,
        agentName: 'agent1'
      };

      const allMessagesResponse: MessageListResponse = {
        roomName: 'general',
        messages: [{ id: '1' } as any, { id: '2' } as any],
        count: 2,
        hasMore: false
      };

      const mentionsOnlyResponse: MessageListResponse = {
        roomName: 'general',
        messages: [{ id: '1' } as any],
        count: 1,
        hasMore: false
      };

      // Cache both variations
      cache.set({ ...baseParams, mentionsOnly: false }, allMessagesResponse);
      cache.set({ ...baseParams, mentionsOnly: true }, mentionsOnlyResponse);

      // Should return different cached results
      expect(cache.get({ ...baseParams, mentionsOnly: false })).toEqual(allMessagesResponse);
      expect(cache.get({ ...baseParams, mentionsOnly: true })).toEqual(mentionsOnlyResponse);
    });
  });

  describe('cache statistics', () => {
    it('should provide accurate cache size and capacity', () => {
      expect(cache.size).toBe(0);
      expect(cache.cacheCapacity).toBe(maxCacheSize);

      const response: MessageListResponse = {
        roomName: 'test',
        messages: [],
        count: 0,
        hasMore: false
      };

      cache.set('key1', response);
      expect(cache.size).toBe(1);

      cache.set('key2', response);
      expect(cache.size).toBe(2);
    });

    it('should provide cache statistics', () => {
      const stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.capacity).toBe(maxCacheSize);
    });
  });

  describe('performance requirements', () => {
    it('should handle high-frequency cache operations', () => {
      const operationCount = 1000;
      const response: MessageListResponse = {
        roomName: 'test',
        messages: [],
        count: 0,
        hasMore: false
      };

      const startTime = performance.now();

      // Perform many cache operations
      for (let i = 0; i < operationCount; i++) {
        const key = `room${i % 10}:50:0:false:`;
        cache.set(key, response);
        cache.get(key);
      }

      const endTime = performance.now();
      const elapsedTime = endTime - startTime;

      // Should complete operations efficiently
      expect(elapsedTime).toBeLessThan(100); // Less than 100ms for 1000 operations
    });
  });
});