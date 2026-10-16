import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LockService } from '../services/LockService';
import { MessagingAdapter } from '../adapters/MessagingAdapter';
import { RoomsAdapter } from '../adapters/RoomsAdapter';
import { ManagementAdapter } from '../adapters/ManagementAdapter';
import { allTools, cloudTools, handleDownloadAttachment, toolHandlers } from '../tools/index';
import { AppError } from '../errors/index';
import { getCloudBackend, type CloudBackend, type OperatingMode } from '../cloud/index';
import { RoomIdentity } from './RoomIdentity';

// Type guard for tool names
function isValidToolName(name: string): name is keyof typeof toolHandlers {
  return name in toolHandlers;
}

export class ToolRegistry {
  private lockService: LockService;
  private messagingAdapter: MessagingAdapter;
  private roomsAdapter: RoomsAdapter;
  private managementAdapter: ManagementAdapter;
  // The names enter_room selected for this MCP instance, per room (MCP-facing; the adapters keep taking explicit names)
  private readonly identity: RoomIdentity;
  // Cloud mode when AGENT_COMM_TOKEN is set (docs/cloud-architecture.md §5.1)
  private readonly cloud: CloudBackend | null = getCloudBackend();
  
  constructor(dataDir?: string) {
    this.lockService = new LockService(dataDir);
    this.messagingAdapter = new MessagingAdapter(this.lockService);
    this.roomsAdapter = new RoomsAdapter(this.lockService);
    this.managementAdapter = new ManagementAdapter(this.lockService);
    
    // Set up cross-adapter dependencies
    this.messagingAdapter.setRoomsAdapter(this.roomsAdapter);
    this.managementAdapter.setRoomsAdapter(this.roomsAdapter);
    this.managementAdapter.setMessageAdapter(this.messagingAdapter);
    this.identity = new RoomIdentity(this.roomsAdapter, this.messagingAdapter);
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
      
      // Register tools list handler (attachments are a cloud mode feature: file mode lists the tools without them)
      server.setRequestHandler(listToolsRequestSchema, async () => ({
        tools: this.cloud ? cloudTools : allTools
      }));
      
      // Register tool call handler
      server.setRequestHandler(callToolRequestSchema, async (request, extra) => {
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
            case 'agent_communication_list_room_users':
              result = await handler(args, this.roomsAdapter);
              break;

            case 'agent_communication_enter_room':
              // Remembers the agent name for this room in this MCP instance after the entry succeeds
              result = await this.identity.enterRoom(args);
              break;

            case 'agent_communication_leave_room':
              // Leaving the name this instance selected clears the room's binding and ends its waits
              result = await this.identity.leaveRoom(args);
              break;
              
            case 'agent_communication_send_message':
              // Acts as the name enter_room selected for the room (explicit agentName is rejected); a cancelled call
              // stops uploading its attachments (and does not send the message after them)
              result = await this.identity.sendMessage(args, extra.signal);
              break;
              
            case 'agent_communication_get_messages':
              result = await handler(args, this.messagingAdapter);
              break;
              
            case 'agent_communication_download_attachment':
              result = await handleDownloadAttachment(args, this.messagingAdapter, extra.signal);
              break;
              
            case 'agent_communication_wait_for_messages':
              // Acts as the name enter_room selected for the room; the identity layer owns the call so a switch,
              // a selected-name leave or shutdown can cancel it. The MCP client's cancellation also ends it.
              result = await this.identity.waitForMessages(args, extra.signal);
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
            // 404 for resources (rooms, agents) should be InvalidParams, not MethodNotFound
            const errorCode = error.statusCode >= 400 && error.statusCode < 500 ? ErrorCode.InvalidParams :
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
  
  get mode(): OperatingMode {
    return this.cloud ? 'cloud' : 'file';
  }
  
  async shutdown(): Promise<void> {
    // End this instance's waits, then close only the cloud connections it owns: another same-token MCP server
    // instance in this process keeps its own WebSockets and waits. The waits end first, while their connections are
    // still open (wait_end, and the read position of what a mentionsOnly wait passed over).
    const owned = this.identity.ownedIdentities();
    await this.identity.shutdown();
    await this.cloud?.closeOwned(owned);
  }
}