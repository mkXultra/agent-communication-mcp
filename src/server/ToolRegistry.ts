import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LockService } from '../services/LockService';
import { MessagingAdapter } from '../adapters/MessagingAdapter';
import { RoomsAdapter } from '../adapters/RoomsAdapter';
import { ManagementAdapter } from '../adapters/ManagementAdapter';
import { allTools, toolHandlers } from '../tools/index';
import { AppError } from '../errors/index';

// Type guard for tool names
function isValidToolName(name: string): name is keyof typeof toolHandlers {
  return name in toolHandlers;
}

export class ToolRegistry {
  private lockService: LockService;
  private messagingAdapter: MessagingAdapter;
  private roomsAdapter: RoomsAdapter;
  private managementAdapter: ManagementAdapter;
  
  constructor(dataDir?: string) {
    this.lockService = new LockService(dataDir);
    this.messagingAdapter = new MessagingAdapter(this.lockService);
    this.roomsAdapter = new RoomsAdapter(this.lockService);
    this.managementAdapter = new ManagementAdapter(this.lockService);
    
    // Set up cross-adapter dependencies
    this.messagingAdapter.setRoomsAdapter(this.roomsAdapter);
    this.managementAdapter.setRoomsAdapter(this.roomsAdapter);
    this.managementAdapter.setMessageAdapter(this.messagingAdapter);
  }
  
  async registerAll(server: Server): Promise<void> {
    try {
      // Initialize all adapters
      await Promise.all([
        this.messagingAdapter.initialize(),
        this.roomsAdapter.initialize(),
        this.managementAdapter.initialize()
      ]);
      
      // Define the request schemas
      const listToolsRequestSchema = z.object({
        method: z.literal('tools/list'),
        params: z.object({
          _meta: z.optional(z.object({}))
        }).optional()
      });
      
      const callToolRequestSchema = z.object({
        method: z.literal('tools/call'),
        params: z.object({
          name: z.string(),
          arguments: z.any(),
          _meta: z.optional(z.object({}))
        })
      });
      
      // Register tools list handler
      server.setRequestHandler(listToolsRequestSchema, async () => ({
        tools: allTools
      }));
      
      // Register tool call handler
      server.setRequestHandler(callToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        
        try {
          if (!isValidToolName(name)) {
            throw new AppError(`Unknown tool: ${name}`, 'UNKNOWN_TOOL', 404);
          }
          
          const handler = toolHandlers[name];
          
          // Route to appropriate adapter
          let result;
          switch (name) {
            case 'agent_communication_list_rooms':
            case 'agent_communication_create_room':
            case 'agent_communication_enter_room':
            case 'agent_communication_leave_room':
            case 'agent_communication_list_room_users':
              result = await handler(args, this.roomsAdapter);
              break;
              
            case 'agent_communication_send_message':
            case 'agent_communication_get_messages':
              result = await handler(args, this.messagingAdapter);
              break;
              
            case 'agent_communication_get_status':
            case 'agent_communication_clear_room_messages':
              result = await handler(args, this.managementAdapter);
              break;
              
            default:
              throw new AppError(`Unrouted tool: ${name}`, 'UNROUTED_TOOL', 500);
          }
          
          return result;
        } catch (error) {
          // Convert AppError to MCP error format
          if (error instanceof AppError) {
            // Map HTTP status codes to JSON-RPC error codes
            const errorCode = error.statusCode === 404 ? ErrorCode.MethodNotFound : 
                            error.statusCode >= 400 && error.statusCode < 500 ? ErrorCode.InvalidParams :
                            ErrorCode.InternalError;
            throw new McpError(
              errorCode,
              error.message,
              { errorCode: error.code }
            );
          }
          
          // Handle validation errors (from zod)
          if (error instanceof Error && error.name === 'ZodError') {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Validation error: ${error.message}`,
              { errorCode: 'VALIDATION_ERROR' }
            );
          }
          
          // Handle unknown errors
          throw new McpError(
            ErrorCode.InternalError,
            error instanceof Error ? error.message : 'Internal server error',
            { errorCode: 'INTERNAL_ERROR' }
          );
        }
      });
      
    } catch (error) {
      throw new AppError(
        `Failed to register tools: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'TOOL_REGISTRATION_ERROR',
        500
      );
    }
  }
  
  async shutdown(): Promise<void> {
    // Cleanup resources if needed
    // Currently no explicit cleanup required
  }
}