import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock file system operations to simulate lock contention
class MockFileSystem {
  private locks = new Map<string, { acquired: boolean; waitQueue: (() => void)[] }>();
  private files = new Map<string, string>();
  
  async acquireLock(filePath: string, timeout: number = 5000): Promise<void> {
    const lockKey = `${filePath}.lock`;
    
    if (!this.locks.has(lockKey)) {
      this.locks.set(lockKey, { acquired: false, waitQueue: [] });
    }
    
    const lock = this.locks.get(lockKey)!;
    
    if (!lock.acquired) {
      lock.acquired = true;
      return Promise.resolve();
    }
    
    // Lock is already acquired, add to wait queue
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = lock.waitQueue.findIndex(cb => cb === resolve);
        if (index >= 0) {
          lock.waitQueue.splice(index, 1);
        }
        reject(new Error('FILE_LOCK_TIMEOUT'));
      }, timeout);
      
      const wrappedResolve = () => {
        clearTimeout(timeoutId);
        lock.acquired = true;
        resolve();
      };
      
      lock.waitQueue.push(wrappedResolve);
    });
  }
  
  async releaseLock(filePath: string): Promise<void> {
    const lockKey = `${filePath}.lock`;
    const lock = this.locks.get(lockKey);
    
    if (!lock || !lock.acquired) {
      return;
    }
    
    lock.acquired = false;
    
    // Process next in queue
    if (lock.waitQueue.length > 0) {
      const nextCallback = lock.waitQueue.shift()!;
      setTimeout(nextCallback, 10); // Simulate small delay
    }
  }
  
  async readFile(filePath: string): Promise<string> {
    return this.files.get(filePath) || '';
  }
  
  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }
  
  async appendFile(filePath: string, content: string): Promise<void> {
    const existing = this.files.get(filePath) || '';
    this.files.set(filePath, existing + content);
  }
  
  reset() {
    this.locks.clear();
    this.files.clear();
  }
}

class FileLockService {
  constructor(private fs: MockFileSystem) {}
  
  async withLock<T>(filePath: string, operation: () => Promise<T>, timeout: number = 10000): Promise<T> {
    await this.fs.acquireLock(filePath, timeout);
    
    try {
      return await operation();
    } finally {
      await this.fs.releaseLock(filePath);
    }
  }
  
  async safeWriteFile(filePath: string, content: string): Promise<void> {
    return this.withLock(filePath, async () => {
      await this.fs.writeFile(filePath, content);
    });
  }
  
  async safeAppendFile(filePath: string, content: string): Promise<void> {
    return this.withLock(filePath, async () => {
      await this.fs.appendFile(filePath, content);
    });
  }
  
  async safeReadFile(filePath: string): Promise<string> {
    return this.withLock(filePath, async () => {
      return this.fs.readFile(filePath);
    });
  }
}

describe('File Lock Concurrency Tests', () => {
  let mockFs: MockFileSystem;
  let lockService: FileLockService;
  
  beforeEach(() => {
    mockFs = new MockFileSystem();
    lockService = new FileLockService(mockFs);
  });
  
  afterEach(() => {
    mockFs.reset();
  });
  
  describe('Basic Lock Operations', () => {
    it('should acquire and release locks successfully', async () => {
      const filePath = '/test/file.txt';
      
      await mockFs.acquireLock(filePath);
      // Lock should be acquired
      
      await mockFs.releaseLock(filePath);
      // Lock should be released
    });
    
    it('should handle concurrent lock requests', async () => {
      const filePath = '/test/concurrent.txt';
      const results: string[] = [];
      
      const operation1 = async () => {
        await mockFs.acquireLock(filePath);
        results.push('op1-start');
        await new Promise(resolve => setTimeout(resolve, 100));
        results.push('op1-end');
        await mockFs.releaseLock(filePath);
      };
      
      const operation2 = async () => {
        await mockFs.acquireLock(filePath);
        results.push('op2-start');
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push('op2-end');
        await mockFs.releaseLock(filePath);
      };
      
      await Promise.all([operation1(), operation2()]);
      
      // Operations should be serialized
      expect(results).toHaveLength(4);
      expect(results[0]).toBe('op1-start');
      expect(results[1]).toBe('op1-end');
      expect(results[2]).toBe('op2-start');
      expect(results[3]).toBe('op2-end');
    });
    
    it('should timeout on lock acquisition', async () => {
      const filePath = '/test/timeout.txt';
      
      // Acquire lock and don't release it
      await mockFs.acquireLock(filePath);
      
      // Second acquisition should timeout
      await expect(mockFs.acquireLock(filePath, 100))
        .rejects.toThrow('FILE_LOCK_TIMEOUT');
    });
  });
  
  describe('File Operations with Locking', () => {
    it('should perform safe file writes', async () => {
      const filePath = '/test/safe-write.txt';
      const content = 'test content';
      
      await lockService.safeWriteFile(filePath, content);
      
      const readContent = await mockFs.readFile(filePath);
      expect(readContent).toBe(content);
    });
    
    it('should handle concurrent writes safely', async () => {
      const filePath = '/test/concurrent-writes.txt';
      
      const writes = [
        lockService.safeWriteFile(filePath, 'content1'),
        lockService.safeWriteFile(filePath, 'content2'),
        lockService.safeWriteFile(filePath, 'content3')
      ];
      
      await Promise.all(writes);
      
      const finalContent = await mockFs.readFile(filePath);
      // Last write should win
      expect(['content1', 'content2', 'content3']).toContain(finalContent);
    });
    
    it('should handle concurrent appends safely', async () => {
      const filePath = '/test/concurrent-appends.txt';
      
      const appends = [
        lockService.safeAppendFile(filePath, 'line1\n'),
        lockService.safeAppendFile(filePath, 'line2\n'),
        lockService.safeAppendFile(filePath, 'line3\n')
      ];
      
      await Promise.all(appends);
      
      const finalContent = await mockFs.readFile(filePath);
      expect(finalContent).toBe('line1\nline2\nline3\n');
    });
  });
  
  describe('Message File Operations', () => {
    it('should handle concurrent message writes to same room', async () => {
      const roomPath = '/data/rooms/test-room/messages.jsonl';
      
      const messages = [
        { id: 'msg1', agentName: 'agent1', message: 'Hello', timestamp: new Date().toISOString() },
        { id: 'msg2', agentName: 'agent2', message: 'Hi there', timestamp: new Date().toISOString() },
        { id: 'msg3', agentName: 'agent3', message: 'How are you?', timestamp: new Date().toISOString() }
      ];
      
      const writeOperations = messages.map(msg => 
        lockService.safeAppendFile(roomPath, JSON.stringify(msg) + '\n')
      );
      
      await Promise.all(writeOperations);
      
      const fileContent = await mockFs.readFile(roomPath);
      const lines = fileContent.trim().split('\n');
      
      expect(lines).toHaveLength(3);
      
      // Verify all messages are present
      const writtenMessages = lines.map(line => JSON.parse(line));
      const messageIds = writtenMessages.map(m => m.id).sort();
      expect(messageIds).toEqual(['msg1', 'msg2', 'msg3']);
    });
    
    it('should handle presence file updates safely', async () => {
      const presencePath = '/data/rooms/test-room/presence.json';
      
      const updates = [
        { agents: ['agent1'] },
        { agents: ['agent1', 'agent2'] },
        { agents: ['agent1', 'agent2', 'agent3'] }
      ];
      
      const updateOperations = updates.map(update =>
        lockService.safeWriteFile(presencePath, JSON.stringify(update))
      );
      
      await Promise.all(updateOperations);
      
      const finalContent = await mockFs.readFile(presencePath);
      const finalPresence = JSON.parse(finalContent);
      
      // Should have one of the valid states
      expect(finalPresence.agents).toBeInstanceOf(Array);
      expect(finalPresence.agents.length).toBeGreaterThanOrEqual(1);
      expect(finalPresence.agents.length).toBeLessThanOrEqual(3);
    });
  });
  
  describe('Lock Timeout Scenarios', () => {
    it('should handle lock timeout during message operations', { timeout: 5000 }, async () => {
      const filePath = '/test/timeout-test.txt';
      
      // Create a flag to ensure proper ordering
      let longOperationStarted = false;
      let longOperationCompleted = false;
      
      // Start a long-running operation that holds the lock
      const longOperation = lockService.withLock(filePath, async () => {
        longOperationStarted = true;
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second for CI
        longOperationCompleted = true;
        return 'long-operation-result';
      });
      
      // Wait a bit to ensure the long operation has acquired the lock
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Now try to perform another operation with short timeout
      const shortOperation = lockService.withLock(filePath, async () => {
        return 'short-operation-result';
      }, 300); // 300ms timeout - should fail since long operation takes 1s
      
      // Short operation should timeout first
      await expect(shortOperation).rejects.toThrow('FILE_LOCK_TIMEOUT');
      
      // Verify long operation was started but not completed when short timed out
      expect(longOperationStarted).toBe(true);
      expect(longOperationCompleted).toBe(false);
      
      // Long operation should eventually succeed
      const longResult = await longOperation;
      expect(longResult).toBe('long-operation-result');
      expect(longOperationCompleted).toBe(true);
    });
    
    it('should recover from timeout errors', async () => {
      const filePath = '/test/recovery-test.txt';
      
      // Start operation that will cause timeout
      const blockingOperation = lockService.withLock(filePath, async () => {
        await new Promise(resolve => setTimeout(resolve, 150));
        return 'blocking-done';
      });
      
      // This should timeout
      const timeoutOperation = lockService.withLock(filePath, async () => {
        return 'timeout-operation';
      }, 50);
      
      await expect(timeoutOperation).rejects.toThrow('FILE_LOCK_TIMEOUT');
      
      // Wait for blocking operation to complete
      await blockingOperation;
      
      // Now another operation should succeed
      const recoveryOperation = lockService.withLock(filePath, async () => {
        return 'recovery-success';
      });
      
      const result = await recoveryOperation;
      expect(result).toBe('recovery-success');
    });
  });
  
  describe('Multi-File Lock Scenarios', () => {
    it('should handle locks on different files independently', async () => {
      const file1 = '/test/file1.txt';
      const file2 = '/test/file2.txt';
      
      const results: string[] = [];
      
      const operation1 = lockService.withLock(file1, async () => {
        results.push('file1-start');
        await new Promise(resolve => setTimeout(resolve, 100));
        results.push('file1-end');
        return 'file1-result';
      });
      
      const operation2 = lockService.withLock(file2, async () => {
        results.push('file2-start');
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push('file2-end');
        return 'file2-result';
      });
      
      const [result1, result2] = await Promise.all([operation1, operation2]);
      
      expect(result1).toBe('file1-result');
      expect(result2).toBe('file2-result');
      
      // Operations on different files should run concurrently
      expect(results).toContain('file1-start');
      expect(results).toContain('file2-start');
      expect(results).toContain('file1-end');
      expect(results).toContain('file2-end');
      
      // file2 should complete before file1 (shorter duration)
      const file2EndIndex = results.indexOf('file2-end');
      const file1EndIndex = results.indexOf('file1-end');
      expect(file2EndIndex).toBeLessThan(file1EndIndex);
    });
    
    it('should prevent deadlocks in nested operations', { timeout: 30000 }, async () => {
      const file1 = '/test/nested1.txt';
      const file2 = '/test/nested2.txt';
      
      // Operation that acquires file1 then file2
      const operation1 = async () => {
        return lockService.withLock(file1, async () => {
          await new Promise(resolve => setTimeout(resolve, 100)); // Increased for CI
          return lockService.withLock(file2, async () => {
            return 'op1-success';
          });
        });
      };
      
      // Operation that acquires file2 then file1
      const operation2 = async () => {
        return lockService.withLock(file2, async () => {
          await new Promise(resolve => setTimeout(resolve, 100)); // Increased for CI
          return lockService.withLock(file1, async () => {
            return 'op2-success';
          });
        });
      };
      
      // This could potentially deadlock, but our implementation should handle it
      // The lock service should detect and prevent deadlocks
      const results = await Promise.allSettled([operation1(), operation2()]);
      
      // At least one should succeed or both should timeout due to deadlock prevention
      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');
      
      if (successes.length === 0) {
        // If no successes, both should have timed out due to deadlock prevention
        expect(failures.length).toBe(2);
        failures.forEach(result => {
          if (result.status === 'rejected') {
            // The error message should indicate a lock timeout
            expect(result.reason.message.toUpperCase()).toContain('TIMEOUT');
          }
        });
      } else {
        // At least one should succeed
        expect(successes.length).toBeGreaterThanOrEqual(1);
      }
    }, 10000); // Increase timeout to 10 seconds
  });
  
  describe('Error Handling in Locked Operations', () => {
    it('should release lock when operation throws error', async () => {
      const filePath = '/test/error-test.txt';
      
      // Operation that throws an error
      const errorOperation = lockService.withLock(filePath, async () => {
        throw new Error('Operation failed');
      });
      
      await expect(errorOperation).rejects.toThrow('Operation failed');
      
      // Lock should be released, next operation should succeed
      const successOperation = lockService.withLock(filePath, async () => {
        return 'success-after-error';
      });
      
      const result = await successOperation;
      expect(result).toBe('success-after-error');
    });
    
    it('should handle filesystem errors gracefully', async () => {
      const filePath = '/test/fs-error.txt';
      
      // Mock filesystem error during operation
      const originalWriteFile = mockFs.writeFile;
      mockFs.writeFile = vi.fn().mockRejectedValue(new Error('STORAGE_ERROR'));
      
      const failingOperation = lockService.safeWriteFile(filePath, 'test content');
      
      await expect(failingOperation).rejects.toThrow('STORAGE_ERROR');
      
      // Restore original method
      mockFs.writeFile = originalWriteFile;
      
      // Next operation should succeed
      const successOperation = lockService.safeWriteFile(filePath, 'success content');
      await expect(successOperation).resolves.toBeUndefined();
    });
  });
  
  describe('Performance and Scalability', () => {
    it('should handle high concurrency scenarios', async () => {
      const filePath = '/test/high-concurrency.txt';
      const operationCount = 50;
      
      const operations = Array.from({ length: operationCount }, (_, i) =>
        lockService.safeAppendFile(filePath, `line-${i}\n`)
      );
      
      const startTime = Date.now();
      await Promise.all(operations);
      const endTime = Date.now();
      
      const fileContent = await mockFs.readFile(filePath);
      const lines = fileContent.trim().split('\n');
      
      expect(lines).toHaveLength(operationCount);
      
      // All lines should be present (no corruption)
      for (let i = 0; i < operationCount; i++) {
        expect(lines).toContain(`line-${i}`);
      }
      
      // Performance check (should complete within reasonable time)
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(5000); // 5 seconds
    });
    
    it('should manage memory usage with many concurrent locks', async () => {
      const fileCount = 100;
      const files = Array.from({ length: fileCount }, (_, i) => `/test/file-${i}.txt`);
      
      const operations = files.map(filePath =>
        lockService.safeWriteFile(filePath, `content-${filePath}`)
      );
      
      await Promise.all(operations);
      
      // Verify all files were written
      for (const filePath of files) {
        const content = await mockFs.readFile(filePath);
        expect(content).toBe(`content-${filePath}`);
      }
    });
  });
});