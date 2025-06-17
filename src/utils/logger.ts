// Agent Communication MCP Server - Structured Logger Implementation
// 実装方針に基づく構造化JSON形式ロギング

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: any;
}

export class Logger {
  private readonly context?: string;

  constructor(context?: string) {
    this.context = context;
  }

  log(level: LogLevel, message: string, meta?: Record<string, any>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(this.context && { context: this.context }),
      ...meta
    };

    // Output to stderr to keep stdout clean for MCP protocol
    console.error(JSON.stringify(entry));
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, any>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, any>): void {
    this.log('error', message, meta);
  }

  // Create a child logger with additional context
  child(context: string): Logger {
    const childContext = this.context ? `${this.context}:${context}` : context;
    return new Logger(childContext);
  }
}

// Default logger instance
export const logger = new Logger('agent-communication-mcp');

// Create loggers for specific components
export const createLogger = (context: string): Logger => new Logger(context);