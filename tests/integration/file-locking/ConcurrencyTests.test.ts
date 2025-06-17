import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { LockService, LockTimeoutError } from '../../../src/services/LockService.js';

describe('File Locking Concurrency Tests', () => {
  let testDataDir: string;
  let lockService1: LockService;
  let lockService2: LockService;
  let lockService3: LockService;
  
  beforeEach(async () => {
    // Create temporary test directory
    testDataDir = path.join(process.cwd(), 'lock-test-' + Date.now());
    await fs.mkdir(testDataDir, { recursive: true });
    
    // Create multiple lock service instances to simulate concurrent access
    lockService1 = new LockService(testDataDir, 1000); // 1 second timeout
    lockService2 = new LockService(testDataDir, 1000);
    lockService3 = new LockService(testDataDir, 1000);
  });
  
  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });
  
  describe('Basic File Locking', () => {
    it('should allow exclusive access to file', async () => {
      let service1Completed = false;
      let service2Started = false;
      let service2Completed = false;
      
      const promise1 = lockService1.withLock('test-file.txt', async () => {
        // Hold lock for 200ms
        await new Promise(resolve => setTimeout(resolve, 200));
        service1Completed = true;
        
        // Service 2 should not have started yet
        expect(service2Started).toBe(false);
        return 'result1';
      });
      
      // Start second operation after small delay
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const promise2 = lockService2.withLock('test-file.txt', async () => {
        service2Started = true;
        
        // Service 1 should be completed by now
        expect(service1Completed).toBe(true);
        
        service2Completed = true;
        return 'result2';
      });
      
      const [result1, result2] = await Promise.all([promise1, promise2]);
      
      expect(result1).toBe('result1');
      expect(result2).toBe('result2');
      expect(service1Completed).toBe(true);
      expect(service2Completed).toBe(true);
    });
    
    it('should handle multiple concurrent lock requests', async () => {
      const results: string[] = [];
      const operations = [];
      
      for (let i = 1; i <= 5; i++) {
        operations.push(
          lockService1.withLock('shared-file.txt', async () => {
            // Small delay to ensure ordering matters
            await new Promise(resolve => setTimeout(resolve, 50));
            results.push(`operation-${i}`);
            return `result-${i}`;
          })
        );
      }
      
      const allResults = await Promise.all(operations);
      
      // All operations should complete
      expect(allResults).toHaveLength(5);
      expect(results).toHaveLength(5);
      
      // Results should contain all operations (order may vary due to execution)
      for (let i = 1; i <= 5; i++) {
        expect(results).toContain(`operation-${i}`);
        expect(allResults).toContain(`result-${i}`);
      }
    });
    
    it('should handle lock timeout', async () => {
      // Create a lock service with very short timeout
      const shortTimeoutService = new LockService(testDataDir, 100); // 100ms timeout
      
      let longOperationStarted = false;
      
      // Start long-running operation
      const longOperation = lockService1.withLock('timeout-test.txt', async () => {
        longOperationStarted = true;
        await new Promise(resolve => setTimeout(resolve, 500)); // 500ms operation
        return 'long-result';
      });
      
      // Wait for long operation to start
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(longOperationStarted).toBe(true);
      
      // Try to acquire lock with short timeout - should fail
      await expect(
        shortTimeoutService.withLock('timeout-test.txt', async () => {
          return 'short-result';
        })
      ).rejects.toThrow(LockTimeoutError);
      
      // Long operation should still complete successfully
      const longResult = await longOperation;
      expect(longResult).toBe('long-result');
    });
  });
  
  describe('File Operations with Locking', () => {
    it('should safely handle concurrent file writes', async () => {
      const filePath = 'concurrent-writes.txt';
      const writers = [];
      
      // Multiple services writing to the same file
      for (let i = 1; i <= 10; i++) {
        const serviceIndex = i % 3; // Rotate between 3 services
        const service = [lockService1, lockService2, lockService3][serviceIndex];
        
        writers.push(
          service.withLock(filePath, async () => {
            // Read current content
            const currentContent = await service.readFile(filePath);
            
            // Append new line
            const newContent = currentContent + `Line ${i}\n`;
            
            // Small delay to simulate processing
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Write back
            await service.writeFile(filePath, newContent);
            
            return i;
          })
        );
      }
      
      const results = await Promise.all(writers);
      
      // Verify all writes completed
      expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      
      // Verify final file content
      const finalContent = await lockService1.readFile(filePath);
      const lines = finalContent.trim().split('\n');
      
      expect(lines).toHaveLength(10);
      for (let i = 1; i <= 10; i++) {
        expect(lines).toContain(`Line ${i}`);
      }
    });
    
    it('should handle concurrent file appends', async () => {
      const filePath = 'append-test.jsonl';
      const appenders = [];
      
      for (let i = 1; i <= 20; i++) {
        appenders.push(
          lockService1.withLock(filePath, async () => {
            const message = JSON.stringify({
              id: `msg-${i}`,
              content: `Message ${i}`,
              timestamp: new Date().toISOString()
            });
            
            await lockService1.appendFile(filePath, message + '\n');
            return i;
          })
        );
      }
      
      await Promise.all(appenders);
      
      // Verify all messages were appended
      const content = await lockService1.readFile(filePath);
      const lines = content.trim().split('\n');
      
      expect(lines).toHaveLength(20);
      
      // Parse each line to verify JSON format
      for (let i = 0; i < lines.length; i++) {
        const parsed = JSON.parse(lines[i]);
        expect(parsed.id).toMatch(/^msg-\d+$/);
        expect(parsed.content).toMatch(/^Message \d+$/);
        expect(parsed.timestamp).toBeDefined();
      }
    });
  });
  
  describe('Lock Service Utilities', () => {
    it('should create directories safely', async () => {
      const operations = [];
      
      // Multiple services trying to create the same directory structure
      for (let i = 1; i <= 5; i++) {
        operations.push(
          lockService1.ensureDir(`rooms/room-${i}/subdirectory`)
        );
      }
      
      await Promise.all(operations);
      
      // Verify all directories were created
      for (let i = 1; i <= 5; i++) {
        const fullPath = path.join(testDataDir, `rooms/room-${i}/subdirectory`);
        const stats = await fs.stat(fullPath);
        expect(stats.isDirectory()).toBe(true);
      }
    });
    
    it('should handle file existence checks', async () => {
      const filePath = 'existence-test.txt';
      
      // Initially file should not exist
      expect(await lockService1.fileExists(filePath)).toBe(false);
      
      // Create file
      await lockService1.writeFile(filePath, 'test content');
      
      // Now it should exist
      expect(await lockService1.fileExists(filePath)).toBe(true);
      expect(await lockService2.fileExists(filePath)).toBe(true);
      expect(await lockService3.fileExists(filePath)).toBe(true);
      
      // Delete file
      await lockService1.deleteFile(filePath);
      
      // Should not exist anymore
      expect(await lockService1.fileExists(filePath)).toBe(false);
    });
    
    it('should list files correctly', async () => {
      const dirPath = 'list-test';
      
      // Create some files
      await lockService1.writeFile(`${dirPath}/file1.txt`, 'content1');
      await lockService1.writeFile(`${dirPath}/file2.txt`, 'content2');
      await lockService1.writeFile(`${dirPath}/file3.json`, '{}');
      
      const files = await lockService1.listFiles(dirPath);
      
      expect(files).toHaveLength(3);
      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.txt');
      expect(files).toContain('file3.json');
    });
  });
  
  describe('Error Handling in Concurrent Environment', () => {
    it('should handle errors gracefully without blocking other operations', async () => {
      const results: Array<'success' | 'error'> = [];
      
      const operations = [
        // Successful operation
        lockService1.withLock('error-test.txt', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          results.push('success');
          return 'success-1';
        }),
        
        // Operation that throws error
        lockService2.withLock('error-test.txt', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          results.push('error');
          throw new Error('Intentional error');
        }),
        
        // Another successful operation
        lockService3.withLock('error-test.txt', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          results.push('success');
          return 'success-2';
        })
      ];
      
      const settled = await Promise.allSettled(operations);
      
      // One should fail, two should succeed
      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1].status).toBe('rejected');
      expect(settled[2].status).toBe('fulfilled');
      
      // All operations should have run
      expect(results).toHaveLength(3);
      expect(results.filter(r => r === 'success')).toHaveLength(2);
      expect(results.filter(r => r === 'error')).toHaveLength(1);
    });
    
    it('should clean up locks properly on errors', async () => {
      // Operation that throws error
      await expect(
        lockService1.withLock('cleanup-test.txt', async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');
      
      // Subsequent operation should not be blocked
      const result = await lockService2.withLock('cleanup-test.txt', async () => {
        return 'cleanup-success';
      });
      
      expect(result).toBe('cleanup-success');
    });
  });
  
  describe('Performance under Concurrency', () => {
    it('should handle high concurrency without deadlocks', async () => {
      const numOperations = 50;
      const operations = [];
      
      for (let i = 0; i < numOperations; i++) {
        const service = [lockService1, lockService2, lockService3][i % 3];
        
        operations.push(
          service.withLock(`file-${i % 5}.txt`, async () => {
            // Random delay between 1-10ms
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 1));
            return i;
          })
        );
      }
      
      const startTime = Date.now();
      const results = await Promise.all(operations);
      const endTime = Date.now();
      
      // All operations should complete
      expect(results).toHaveLength(numOperations);
      expect(results.sort((a, b) => a - b)).toEqual(
        Array.from({ length: numOperations }, (_, i) => i)
      );
      
      // Should complete in reasonable time (less than 10 seconds)
      expect(endTime - startTime).toBeLessThan(10000);
    });
  });
});