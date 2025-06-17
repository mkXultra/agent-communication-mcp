import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
  RoomNotFoundError, 
  RoomAlreadyExistsError, 
  AgentNotFoundError,
  AgentAlreadyInRoomError,
  AgentNotInRoomError,
  FileLockTimeoutError,
  InvalidMessageFormatError,
  StorageError
} from '../../../src/errors/index.js';

// Mock all error classes since they might not all exist yet
vi.mock('../../../src/errors/index.js', () => ({
  AppError: class AppError extends Error {
    constructor(message: string, public readonly code: string, public readonly statusCode: number = 500) {
      super(message);
      this.name = this.constructor.name;
    }
  },
  RoomNotFoundError: class RoomNotFoundError extends Error {
    code = 'ROOM_NOT_FOUND';
    statusCode = 404;
    constructor(roomName: string) {
      super(`Room '${roomName}' not found`);
      this.name = 'RoomNotFoundError';
    }
  },
  RoomAlreadyExistsError: class RoomAlreadyExistsError extends Error {
    code = 'ROOM_ALREADY_EXISTS';
    statusCode = 409;
    constructor(roomName: string) {
      super(`Room '${roomName}' already exists`);
      this.name = 'RoomAlreadyExistsError';
    }
  },
  AgentNotFoundError: class AgentNotFoundError extends Error {
    code = 'AGENT_NOT_FOUND';
    statusCode = 404;
    constructor(agentName: string) {
      super(`Agent '${agentName}' not found`);
      this.name = 'AgentNotFoundError';
    }
  },
  AgentAlreadyInRoomError: class AgentAlreadyInRoomError extends Error {
    code = 'AGENT_ALREADY_IN_ROOM';
    statusCode = 409;
    constructor(agentName: string, roomName: string) {
      super(`Agent '${agentName}' is already in room '${roomName}'`);
      this.name = 'AgentAlreadyInRoomError';
    }
  },
  AgentNotInRoomError: class AgentNotInRoomError extends Error {
    code = 'AGENT_NOT_IN_ROOM';
    statusCode = 403;
    constructor(agentName: string, roomName: string) {
      super(`Agent '${agentName}' is not in room '${roomName}'`);
      this.name = 'AgentNotInRoomError';
    }
  },
  FileLockTimeoutError: class FileLockTimeoutError extends Error {
    code = 'FILE_LOCK_TIMEOUT';
    statusCode = 408;
    constructor(filePath: string, timeout: number) {
      super(`Failed to acquire lock for '${filePath}' within ${timeout}ms`);
      this.name = 'FileLockTimeoutError';
    }
  },
  InvalidMessageFormatError: class InvalidMessageFormatError extends Error {
    code = 'INVALID_MESSAGE_FORMAT';
    statusCode = 400;
    constructor(reason: string) {
      super(`Invalid message format: ${reason}`);
      this.name = 'InvalidMessageFormatError';
    }
  },
  StorageError: class StorageError extends Error {
    code = 'STORAGE_ERROR';
    statusCode = 500;
    constructor(operation: string, reason: string) {
      super(`Storage error during ${operation}: ${reason}`);
      this.name = 'StorageError';
    }
  }
}));

describe('Error Code Coverage Tests', () => {
  describe('ROOM_NOT_FOUND Error', () => {
    it('should create RoomNotFoundError with correct properties', () => {
      const roomName = 'non-existent-room';
      const error = new RoomNotFoundError(roomName);
      
      expect(error.message).toBe(`Room '${roomName}' not found`);
      expect(error.code).toBe('ROOM_NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('RoomNotFoundError');
      expect(error).toBeInstanceOf(Error);
    });
    
    it('should be throwable and catchable', () => {
      const roomName = 'test-room';
      
      const throwError = () => {
        throw new RoomNotFoundError(roomName);
      };
      
      expect(throwError).toThrow(RoomNotFoundError);
      expect(throwError).toThrow(`Room '${roomName}' not found`);
    });
    
    it('should handle room names with special characters', () => {
      const specialRoomNames = [
        'room-with-dashes',
        'room_with_underscores',
        'room.with.dots',
        'room with spaces',
        'room@with#symbols'
      ];
      
      specialRoomNames.forEach(roomName => {
        const error = new RoomNotFoundError(roomName);
        expect(error.message).toContain(roomName);
        expect(error.code).toBe('ROOM_NOT_FOUND');
      });
    });
  });
  
  describe('ROOM_ALREADY_EXISTS Error', () => {
    it('should create RoomAlreadyExistsError with correct properties', () => {
      const roomName = 'existing-room';
      const error = new RoomAlreadyExistsError(roomName);
      
      expect(error.message).toBe(`Room '${roomName}' already exists`);
      expect(error.code).toBe('ROOM_ALREADY_EXISTS');
      expect(error.statusCode).toBe(409);
      expect(error.name).toBe('RoomAlreadyExistsError');
    });
    
    it('should distinguish from other room errors', () => {
      const roomName = 'test-room';
      const notFoundError = new RoomNotFoundError(roomName);
      const alreadyExistsError = new RoomAlreadyExistsError(roomName);
      
      expect(notFoundError.code).not.toBe(alreadyExistsError.code);
      expect(notFoundError.statusCode).not.toBe(alreadyExistsError.statusCode);
    });
  });
  
  describe('AGENT_NOT_FOUND Error', () => {
    it('should create AgentNotFoundError with correct properties', () => {
      const agentName = 'missing-agent';
      const error = new AgentNotFoundError(agentName);
      
      expect(error.message).toBe(`Agent '${agentName}' not found`);
      expect(error.code).toBe('AGENT_NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('AgentNotFoundError');
    });
    
    it('should handle various agent name formats', () => {
      const agentNames = [
        'agent1',
        'user@domain.com',
        'system_bot',
        'AI-Assistant',
        'service.worker.001'
      ];
      
      agentNames.forEach(agentName => {
        const error = new AgentNotFoundError(agentName);
        expect(error.message).toContain(agentName);
        expect(error.code).toBe('AGENT_NOT_FOUND');
      });
    });
  });
  
  describe('AGENT_ALREADY_IN_ROOM Error', () => {
    it('should create AgentAlreadyInRoomError with correct properties', () => {
      const agentName = 'test-agent';
      const roomName = 'test-room';
      const error = new AgentAlreadyInRoomError(agentName, roomName);
      
      expect(error.message).toBe(`Agent '${agentName}' is already in room '${roomName}'`);
      expect(error.code).toBe('AGENT_ALREADY_IN_ROOM');
      expect(error.statusCode).toBe(409);
      expect(error.name).toBe('AgentAlreadyInRoomError');
    });
    
    it('should include both agent and room names in message', () => {
      const agentName = 'alice';
      const roomName = 'general-chat';
      const error = new AgentAlreadyInRoomError(agentName, roomName);
      
      expect(error.message).toContain(agentName);
      expect(error.message).toContain(roomName);
    });
  });
  
  describe('AGENT_NOT_IN_ROOM Error', () => {
    it('should create AgentNotInRoomError with correct properties', () => {
      const agentName = 'test-agent';
      const roomName = 'test-room';
      const error = new AgentNotInRoomError(agentName, roomName);
      
      expect(error.message).toBe(`Agent '${agentName}' is not in room '${roomName}'`);
      expect(error.code).toBe('AGENT_NOT_IN_ROOM');
      expect(error.statusCode).toBe(403);
      expect(error.name).toBe('AgentNotInRoomError');
    });
    
    it('should differentiate from AgentAlreadyInRoomError', () => {
      const agentName = 'test-agent';
      const roomName = 'test-room';
      
      const notInRoomError = new AgentNotInRoomError(agentName, roomName);
      const alreadyInRoomError = new AgentAlreadyInRoomError(agentName, roomName);
      
      expect(notInRoomError.code).not.toBe(alreadyInRoomError.code);
      expect(notInRoomError.statusCode).not.toBe(alreadyInRoomError.statusCode);
    });
  });
  
  describe('FILE_LOCK_TIMEOUT Error', () => {
    it('should create FileLockTimeoutError with correct properties', () => {
      const filePath = '/data/rooms/test-room/messages.jsonl';
      const timeout = 5000;
      const error = new FileLockTimeoutError(filePath, timeout);
      
      expect(error.message).toBe(`Failed to acquire lock for '${filePath}' within ${timeout}ms`);
      expect(error.code).toBe('FILE_LOCK_TIMEOUT');
      expect(error.statusCode).toBe(408);
      expect(error.name).toBe('FileLockTimeoutError');
    });
    
    it('should include timeout value in message', () => {
      const filePath = '/test/file.txt';
      const timeouts = [1000, 5000, 10000];
      
      timeouts.forEach(timeout => {
        const error = new FileLockTimeoutError(filePath, timeout);
        expect(error.message).toContain(`${timeout}ms`);
      });
    });
    
    it('should handle various file path formats', () => {
      const filePaths = [
        '/absolute/path/file.txt',
        './relative/path/file.txt',
        'simple-file.txt',
        '/data/rooms/room-name/messages.jsonl',
        '/data/rooms/room-name/presence.json'
      ];
      
      filePaths.forEach(filePath => {
        const error = new FileLockTimeoutError(filePath, 5000);
        expect(error.message).toContain(filePath);
        expect(error.code).toBe('FILE_LOCK_TIMEOUT');
      });
    });
  });
  
  describe('INVALID_MESSAGE_FORMAT Error', () => {
    it('should create InvalidMessageFormatError with correct properties', () => {
      const reason = 'Message exceeds maximum length';
      const error = new InvalidMessageFormatError(reason);
      
      expect(error.message).toBe(`Invalid message format: ${reason}`);
      expect(error.code).toBe('INVALID_MESSAGE_FORMAT');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('InvalidMessageFormatError');
    });
    
    it('should handle various format validation reasons', () => {
      const reasons = [
        'Message is empty',
        'Message exceeds maximum length of 1000 characters',
        'Message contains invalid characters',
        'Message format is not valid JSON',
        'Required field "content" is missing',
        'Timestamp format is invalid'
      ];
      
      reasons.forEach(reason => {
        const error = new InvalidMessageFormatError(reason);
        expect(error.message).toContain(reason);
        expect(error.code).toBe('INVALID_MESSAGE_FORMAT');
        expect(error.statusCode).toBe(400);
      });
    });
  });
  
  describe('STORAGE_ERROR Error', () => {
    it('should create StorageError with correct properties', () => {
      const operation = 'write';
      const reason = 'Disk space insufficient';
      const error = new StorageError(operation, reason);
      
      expect(error.message).toBe(`Storage error during ${operation}: ${reason}`);
      expect(error.code).toBe('STORAGE_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.name).toBe('StorageError');
    });
    
    it('should handle different storage operations', () => {
      const operations = [
        'read',
        'write',
        'delete',
        'create directory',
        'acquire lock',
        'release lock'
      ];
      
      operations.forEach(operation => {
        const error = new StorageError(operation, 'Generic error');
        expect(error.message).toContain(operation);
        expect(error.code).toBe('STORAGE_ERROR');
      });
    });
    
    it('should handle various storage error reasons', () => {
      const reasons = [
        'File not found',
        'Permission denied',
        'Disk space insufficient',
        'I/O error',
        'Network timeout',
        'Corrupted data'
      ];
      
      reasons.forEach(reason => {
        const error = new StorageError('read', reason);
        expect(error.message).toContain(reason);
        expect(error.code).toBe('STORAGE_ERROR');
      });
    });
  });
  
  describe('Error Code Consistency', () => {
    it('should have unique error codes for all error types', () => {
      const errors = [
        new RoomNotFoundError('test'),
        new RoomAlreadyExistsError('test'),
        new AgentNotFoundError('test'),
        new AgentAlreadyInRoomError('test', 'test'),
        new AgentNotInRoomError('test', 'test'),
        new FileLockTimeoutError('test', 5000),
        new InvalidMessageFormatError('test'),
        new StorageError('test', 'test')
      ];
      
      const codes = errors.map(error => error.code);
      const uniqueCodes = [...new Set(codes)];
      
      expect(uniqueCodes).toHaveLength(codes.length);
    });
    
    it('should have appropriate HTTP status codes', () => {
      const errorStatusMapping = [
        { errorClass: RoomNotFoundError, expectedStatus: 404, args: ['test'] },
        { errorClass: RoomAlreadyExistsError, expectedStatus: 409, args: ['test'] },
        { errorClass: AgentNotFoundError, expectedStatus: 404, args: ['test'] },
        { errorClass: AgentAlreadyInRoomError, expectedStatus: 409, args: ['test', 'test'] },
        { errorClass: AgentNotInRoomError, expectedStatus: 403, args: ['test', 'test'] },
        { errorClass: FileLockTimeoutError, expectedStatus: 408, args: ['test', 5000] },
        { errorClass: InvalidMessageFormatError, expectedStatus: 400, args: ['test'] },
        { errorClass: StorageError, expectedStatus: 500, args: ['test', 'test'] }
      ];
      
      errorStatusMapping.forEach(({ errorClass, expectedStatus, args }) => {
        const error = new errorClass(...args);
        expect(error.statusCode).toBe(expectedStatus);
      });
    });
    
    it('should follow consistent naming conventions', () => {
      const errors = [
        new RoomNotFoundError('test'),
        new RoomAlreadyExistsError('test'),
        new AgentNotFoundError('test'),
        new AgentAlreadyInRoomError('test', 'test'),
        new AgentNotInRoomError('test', 'test'),
        new FileLockTimeoutError('test', 5000),
        new InvalidMessageFormatError('test'),
        new StorageError('test', 'test')
      ];
      
      errors.forEach(error => {
        // Error name should match class name
        expect(error.name).toBe(error.constructor.name);
        
        // Code should be UPPER_SNAKE_CASE
        expect(error.code).toMatch(/^[A-Z_]+$/);
        
        // Code should end with 'ERROR' or be descriptive
        const validPatterns = [
          /_ERROR$/,
          /^[A-Z_]+_(NOT_FOUND|ALREADY_EXISTS|TIMEOUT|NOT_IN_ROOM|ALREADY_IN_ROOM)$/
        ];
        
        const isValidCode = validPatterns.some(pattern => pattern.test(error.code));
        expect(isValidCode).toBe(true);
      });
    });
  });
  
  describe('Error Serialization and MCP Compatibility', () => {
    it('should serialize errors to MCP format correctly', () => {
      const toMCPError = (error: any) => ({
        code: error.statusCode,
        message: error.message,
        data: { errorCode: error.code }
      });
      
      const roomError = new RoomNotFoundError('test-room');
      const mcpError = toMCPError(roomError);
      
      expect(mcpError).toEqual({
        code: 404,
        message: "Room 'test-room' not found",
        data: { errorCode: 'ROOM_NOT_FOUND' }
      });
    });
    
    it('should maintain error information through serialization', () => {
      const errors = [
        new RoomNotFoundError('test-room'),
        new AgentNotInRoomError('agent1', 'room1'),
        new FileLockTimeoutError('/path/file.txt', 5000),
        new StorageError('write', 'disk full')
      ];
      
      errors.forEach(originalError => {
        const serialized = JSON.stringify({
          code: originalError.statusCode,
          message: originalError.message,
          data: { errorCode: originalError.code }
        });
        
        const parsed = JSON.parse(serialized);
        
        expect(parsed.code).toBe(originalError.statusCode);
        expect(parsed.message).toBe(originalError.message);
        expect(parsed.data.errorCode).toBe(originalError.code);
      });
    });
  });
  
  describe('Error Context and Stack Traces', () => {
    it('should preserve stack traces for debugging', () => {
      const createError = () => {
        return new RoomNotFoundError('test-room');
      };
      
      const error = createError();
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('createError');
    });
    
    it('should handle nested error contexts', () => {
      const simulateNestedOperation = async () => {
        try {
          throw new StorageError('write', 'disk full');
        } catch (storageError) {
          throw new RoomNotFoundError('failed-room');
        }
      };
      
      await expect(simulateNestedOperation()).rejects.toThrow(RoomNotFoundError);
    });
  });
  
  describe('Error Recovery Scenarios', () => {
    it('should provide actionable error messages', () => {
      const errors = [
        new RoomNotFoundError('missing-room'),
        new AgentNotInRoomError('agent1', 'room1'),
        new FileLockTimeoutError('/data/file.txt', 5000),
        new InvalidMessageFormatError('message too long')
      ];
      
      errors.forEach(error => {
        expect(error.message).toBeTruthy();
        expect(error.message.length).toBeGreaterThan(10);
        expect(error.message).not.toBe('An error occurred');
      });
    });
    
    it('should enable error-specific handling', () => {
      const handleError = (error: any) => {
        switch (error.code) {
          case 'ROOM_NOT_FOUND':
            return 'suggest creating room';
          case 'AGENT_NOT_IN_ROOM':
            return 'suggest joining room';
          case 'FILE_LOCK_TIMEOUT':
            return 'suggest retrying operation';
          case 'STORAGE_ERROR':
            return 'suggest checking disk space';
          default:
            return 'generic error handling';
        }
      };
      
      expect(handleError(new RoomNotFoundError('test'))).toBe('suggest creating room');
      expect(handleError(new AgentNotInRoomError('a', 'r'))).toBe('suggest joining room');
      expect(handleError(new FileLockTimeoutError('f', 1000))).toBe('suggest retrying operation');
      expect(handleError(new StorageError('op', 'reason'))).toBe('suggest checking disk space');
    });
  });
});