import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LockService } from '../services/LockService';
import { MessagingAdapter } from '../adapters/MessagingAdapter';
import { RoomsAdapter } from '../adapters/RoomsAdapter';
import { ManagementAdapter } from '../adapters/ManagementAdapter';
import { allTools, cloudTools, handleDownloadAttachment, handleSendMessage, handleWaitForMessages, toolHandlers } from '../tools/index';
import { AppError, WaitCancelledError } from '../errors/index';
import { getCloudBackend, type CloudBackend, type OperatingMode } from '../cloud/index';
import { linkAbortSignals, settledOrAborted } from '../utils/abort';

/**
 * How long shutdown() gives the waits it ends to finish (wait_end, the read position of what a mentionsOnly wait passed
 * over, the waiting-agents entry) before it closes the connections and returns.
 */
const SHUTDOWN_GRACE_MS = 2000;

// Type guard for tool names
function isValidToolName(name: string): name is keyof typeof toolHandlers {
  return name in toolHandlers;
}

export class ToolRegistry {
  private lockService: LockService;
  private messagingAdapter: MessagingAdapter;
  private roomsAdapter: RoomsAdapter;
  private managementAdapter: ManagementAdapter;
  // Cloud mode when AGENT_COMM_TOKEN is set (docs/cloud-architecture.md §5.1)
  private readonly cloud: CloudBackend | null = getCloudBackend();
  // wait_for_messages calls in progress; shutdown() ends them (a wait without a time limit never ends on its own)
  private readonly waits = new Set<{ abort: (reason: unknown) => void; settled: Promise<unknown> }>();
  
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
            case 'agent_communication_enter_room':
            case 'agent_communication_leave_room':
            case 'agent_communication_list_room_users':
              result = await handler(args, this.roomsAdapter);
              break;
              
            case 'agent_communication_send_message':
              // A cancelled call stops uploading its attachments (and does not send the message after them)
              result = await handleSendMessage(args, this.messagingAdapter, extra.signal);
              break;
              
            case 'agent_communication_get_messages':
              result = await handler(args, this.messagingAdapter);
              break;
              
            case 'agent_communication_download_attachment':
              result = await handleDownloadAttachment(args, this.messagingAdapter, extra.signal);
              break;
              
            case 'agent_communication_wait_for_messages':
              // Ends early when the client cancels the request (notifications/cancelled) or the server shuts down
              result = await this.waitForMessages(args, extra.signal);
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
    // End the waits in progress. A cancelled wait returns nothing and consumes nothing: what arrived stays unread.
    const waits = [...this.waits];
    for (const wait of waits) wait.abort(new WaitCancelledError('the server is shutting down'));
    // The waits end first, while their connections are still open: wait_end, and the read position of what a
    // mentionsOnly wait passed over. AbortSignal.timeout does not keep the process alive once the waits are done.
    await settledOrAborted(Promise.all(waits.map((wait) => wait.settled)), AbortSignal.timeout(SHUTDOWN_GRACE_MS));
    // Cloud mode keeps a WebSocket per room x agent for the process lifetime; close them.
    await this.cloud?.close();
  }
  
  private async waitForMessages(args: unknown, requestSignal: AbortSignal): Promise<{ content: Array<{ type: string; text: string }> }> {
    const link = linkAbortSignals(requestSignal);
    const result = handleWaitForMessages(args, this.messagingAdapter, link.signal);
    const wait = { abort: link.abort, settled: result.catch(() => undefined) };
    this.waits.add(wait);
    try {
      return await result;
    } finally {
      this.waits.delete(wait);
      link.dispose();
    }
  }
}