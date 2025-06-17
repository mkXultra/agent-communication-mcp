import { AppError } from '../errors/index.js';

export class ErrorHandler {
  static toMCPError(error: unknown) {
    if (error instanceof AppError) {
      return {
        code: error.statusCode,
        message: error.message,
        data: { errorCode: error.code }
      };
    }
    
    // Handle validation errors (from zod)
    if (error instanceof Error && error.name === 'ZodError') {
      return {
        code: 400,
        message: `Validation error: ${error.message}`,
        data: { errorCode: 'VALIDATION_ERROR' }
      };
    }
    
    // Handle Node.js system errors
    if (error instanceof Error && 'code' in error) {
      const nodeError = error as NodeJS.ErrnoException;
      switch (nodeError.code) {
        case 'ENOENT':
          return {
            code: 404,
            message: 'File or directory not found',
            data: { errorCode: 'FILE_NOT_FOUND' }
          };
        case 'EACCES':
          return {
            code: 403,
            message: 'Permission denied',
            data: { errorCode: 'PERMISSION_DENIED' }
          };
        case 'EEXIST':
          return {
            code: 409,
            message: 'File already exists',
            data: { errorCode: 'FILE_EXISTS' }
          };
        default:
          return {
            code: 500,
            message: `System error: ${nodeError.message}`,
            data: { errorCode: 'SYSTEM_ERROR', details: nodeError.code }
          };
      }
    }
    
    // Default error handling
    return {
      code: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
      data: { errorCode: 'INTERNAL_ERROR' }
    };
  }
  
  static logError(error: unknown, context?: string): void {
    const timestamp = new Date().toISOString();
    const errorInfo = {
      timestamp,
      context: context || 'unknown',
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : { message: String(error) }
    };
    
    console.error(JSON.stringify(errorInfo));
  }
}