import { promises as fs } from 'fs';
import path from 'path';
import { AppError } from '../errors/index.js';

export class LockTimeoutError extends AppError {
  constructor(filePath: string, timeout: number) {
    super(`Lock timeout after ${timeout}ms for file: ${filePath}`, 'LOCK_TIMEOUT', 408);
  }
}

export class LockService {
  private static readonly DEFAULT_TIMEOUT = 5000; // 5 seconds
  private static readonly RETRY_INTERVAL = 50; // 50ms
  
  private activeLocks = new Map<string, Promise<void>>();
  
  constructor(
    private readonly dataDir: string = process.env.AGENT_COMM_DATA_DIR || './data',
    private readonly lockTimeout: number = parseInt(process.env.AGENT_COMM_LOCK_TIMEOUT || '5000')
  ) {}
  
  /**
   * Execute a function with exclusive file lock
   */
  async withLock<T>(relativePath: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = this.normalizePath(relativePath);
    
    // Wait for any existing lock on this file
    if (this.activeLocks.has(lockKey)) {
      await this.activeLocks.get(lockKey);
    }
    
    // Create new lock
    let resolveLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    
    this.activeLocks.set(lockKey, lockPromise);
    
    try {
      // Acquire file system lock
      await this.acquireFileLock(lockKey);
      
      // Execute the operation
      const result = await operation();
      
      return result;
    } finally {
      // Release file system lock
      await this.releaseFileLock(lockKey);
      
      // Remove from active locks
      this.activeLocks.delete(lockKey);
      resolveLock!();
    }
  }
  
  /**
   * Acquire file system lock using lock file
   */
  private async acquireFileLock(filePath: string): Promise<void> {
    const lockFilePath = `${filePath}.lock`;
    const startTime = Date.now();
    
    // ロックファイルの親ディレクトリを確保
    const lockFileDir = path.dirname(lockFilePath);
    try {
      await fs.mkdir(lockFileDir, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw new AppError(`Failed to create lock directory: ${error.message}`, 'LOCK_DIR_ERROR', 500);
      }
    }
    
    while (Date.now() - startTime < this.lockTimeout) {
      try {
        // Try to create lock file exclusively
        await fs.writeFile(lockFilePath, process.pid.toString(), { flag: 'wx' });
        return; // Successfully acquired lock
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // Lock file exists, check if it's stale
          const isStale = await this.isLockStale(lockFilePath);
          if (isStale) {
            // Remove stale lock and try again
            try {
              await fs.unlink(lockFilePath);
              continue;
            } catch {
              // Someone else might have removed it, continue
            }
          }
          
          // Wait before retry
          await this.sleep(LockService.RETRY_INTERVAL);
          continue;
        } else if (error.code === 'ENOENT') {
          // ディレクトリが作成されたにも関わらずENOENTが発生した場合は再試行
          continue;
        } else {
          // Some other error occurred
          throw new AppError(`Failed to acquire lock: ${error.message}`, 'LOCK_ERROR', 500);
        }
      }
    }
    
    throw new LockTimeoutError(filePath, this.lockTimeout);
  }
  
  /**
   * Release file system lock
   */
  private async releaseFileLock(filePath: string): Promise<void> {
    const lockFilePath = `${filePath}.lock`;
    
    try {
      await fs.unlink(lockFilePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        // Log error but don't throw - releasing lock should be best effort
        console.warn(`Warning: Failed to release lock file ${lockFilePath}:`, error.message);
      }
    }
  }
  
  /**
   * Check if lock file is stale (process no longer exists)
   */
  private async isLockStale(lockFilePath: string): Promise<boolean> {
    try {
      const pidString = await fs.readFile(lockFilePath, 'utf8');
      const pid = parseInt(pidString.trim());
      
      if (isNaN(pid)) {
        return true; // Invalid PID format
      }
      
      // Check if process exists
      try {
        process.kill(pid, 0); // Signal 0 checks existence without killing
        return false; // Process exists
      } catch {
        return true; // Process doesn't exist
      }
    } catch {
      return true; // Can't read lock file
    }
  }
  
  /**
   * Normalize file path for consistent lock keys
   */
  private normalizePath(relativePath: string): string {
    const fullPath = path.resolve(this.dataDir, relativePath);
    return path.normalize(fullPath);
  }
  
  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Ensure directory exists
   */
  async ensureDir(dirPath: string): Promise<void> {
    const fullPath = path.resolve(this.dataDir, dirPath);
    try {
      await fs.mkdir(fullPath, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw new AppError(`Failed to create directory ${fullPath}: ${error.message}`, 'DIR_CREATE_ERROR', 500);
      }
    }
  }
  
  /**
   * Check if file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    const fullPath = path.resolve(this.dataDir, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Read file with automatic directory creation
   */
  async readFile(filePath: string): Promise<string> {
    const fullPath = path.resolve(this.dataDir, filePath);
    
    try {
      return await fs.readFile(fullPath, 'utf8');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty string
        return '';
      }
      throw new AppError(`Failed to read file ${fullPath}: ${error.message}`, 'FILE_READ_ERROR', 500);
    }
  }
  
  /**
   * Write file with automatic directory creation
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = path.resolve(this.dataDir, filePath);
    const dirPath = path.dirname(fullPath);
    
    // Ensure directory exists
    await fs.mkdir(dirPath, { recursive: true });
    
    try {
      await fs.writeFile(fullPath, content, 'utf8');
    } catch (error: any) {
      throw new AppError(`Failed to write file ${fullPath}: ${error.message}`, 'FILE_WRITE_ERROR', 500);
    }
  }
  
  /**
   * Append to file with automatic directory creation
   */
  async appendFile(filePath: string, content: string): Promise<void> {
    const fullPath = path.resolve(this.dataDir, filePath);
    const dirPath = path.dirname(fullPath);
    
    // Ensure directory exists
    await fs.mkdir(dirPath, { recursive: true });
    
    try {
      await fs.appendFile(fullPath, content, 'utf8');
    } catch (error: any) {
      throw new AppError(`Failed to append to file ${fullPath}: ${error.message}`, 'FILE_APPEND_ERROR', 500);
    }
  }
  
  /**
   * Delete file safely
   */
  async deleteFile(filePath: string): Promise<void> {
    const fullPath = path.resolve(this.dataDir, filePath);
    
    try {
      await fs.unlink(fullPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw new AppError(`Failed to delete file ${fullPath}: ${error.message}`, 'FILE_DELETE_ERROR', 500);
      }
    }
  }
  
  /**
   * List files in directory
   */
  async listFiles(dirPath: string): Promise<string[]> {
    const fullPath = path.resolve(this.dataDir, dirPath);
    
    try {
      return await fs.readdir(fullPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw new AppError(`Failed to list directory ${fullPath}: ${error.message}`, 'DIR_READ_ERROR', 500);
    }
  }
}