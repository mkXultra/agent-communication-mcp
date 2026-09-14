#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolRegistry } from './server/ToolRegistry.js';
import { ErrorHandler } from './server/ErrorHandler.js';
import { getDataDirectory } from './utils/dataDir.js';
import { fileModeNotice, resolveCloudConfig } from './cloud/index.js';

async function main() {
  try {
    // Create MCP server with tool capabilities
    const server = new Server({
      name: 'agent-communication',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {}  // Enable tool support
      }
    });
    
    // Initialize and register tools
    const dataDir = getDataDirectory();
    const toolRegistry = new ToolRegistry(dataDir);
    
    await toolRegistry.registerAll(server);
    
    // Set up error handling
    server.onerror = (error) => {
      ErrorHandler.logError(error, 'MCP Server');
    };
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.error('Received SIGINT, shutting down gracefully...');
      try {
        await toolRegistry.shutdown();
        process.exit(0);
      } catch (error) {
        ErrorHandler.logError(error, 'Shutdown');
        process.exit(1);
      }
    });
    
    process.on('SIGTERM', async () => {
      console.error('Received SIGTERM, shutting down gracefully...');
      try {
        await toolRegistry.shutdown();
        process.exit(0);
      } catch (error) {
        ErrorHandler.logError(error, 'Shutdown');
        process.exit(1);
      }
    });
    
    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    console.error('Agent Communication MCP Server started on stdio');
    
    // docs/cloud-architecture.md §5.1: AGENT_COMM_TOKEN selects cloud mode. stderr only: stdout is the MCP stdio channel.
    const cloudConfig = resolveCloudConfig();
    if (cloudConfig) {
      console.error(`Cloud mode: ${cloudConfig.apiUrl}`);
    } else {
      console.error(fileModeNotice());
    }
    
    // The MCP client closed stdin: end the waits in progress (one without a time limit would keep the process alive).
    // Cloud mode also releases the WebSockets it holds for the process lifetime and exits; file mode exits by itself
    // once the file operations under way are done.
    process.stdin.once('end', async () => {
      await toolRegistry.shutdown();
      if (cloudConfig) process.exit(0);
    });
    
  } catch (error) {
    ErrorHandler.logError(error, 'Server startup');
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  ErrorHandler.logError({
    reason,
    promise: promise.toString()
  }, 'Unhandled promise rejection');
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  ErrorHandler.logError(error, 'Uncaught exception');
  process.exit(1);
});

if (require.main === module) {
  main();
}