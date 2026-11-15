// Room management tools
import {
  listRoomsTool,
  createRoomTool,
  cloudCreateRoomTool,
  enterRoomTool,
  leaveRoomTool,
  listRoomUsersTool,
  handleListRooms,
  handleCreateRoom,
  handleEnterRoom,
  handleLeaveRoom,
  handleListRoomUsers
} from './room';

export {
  listRoomsTool,
  createRoomTool,
  cloudCreateRoomTool,
  enterRoomTool,
  leaveRoomTool,
  listRoomUsersTool,
  handleListRooms,
  handleCreateRoom,
  handleEnterRoom,
  handleLeaveRoom,
  handleListRoomUsers
};

// Messaging tools
import {
  sendMessageTool,
  cloudSendMessageTool,
  getMessagesTool,
  cloudGetMessagesTool,
  waitForMessagesTool,
  cloudWaitForMessagesTool,
  downloadAttachmentTool,
  deleteAttachmentsThroughPostTool,
  handleSendMessage,
  handleGetMessages,
  handleWaitForMessages,
  handleDownloadAttachment,
  handleDeleteAttachmentsThroughPost
} from './messaging';

export {
  sendMessageTool,
  cloudSendMessageTool,
  getMessagesTool,
  cloudGetMessagesTool,
  waitForMessagesTool,
  cloudWaitForMessagesTool,
  downloadAttachmentTool,
  deleteAttachmentsThroughPostTool,
  handleSendMessage,
  handleGetMessages,
  handleWaitForMessages,
  handleDownloadAttachment,
  handleDeleteAttachmentsThroughPost
};

// Management tools
import {
  getStatusTool,
  clearRoomMessagesTool,
  handleGetStatus,
  handleClearRoomMessages
} from './management';

export {
  getStatusTool,
  clearRoomMessagesTool,
  handleGetStatus,
  handleClearRoomMessages
};

// All tools array for easy registration
export const allTools = [
  // Room management
  listRoomsTool,
  createRoomTool,
  enterRoomTool,
  leaveRoomTool,
  listRoomUsersTool,
  
  // Messaging
  sendMessageTool,
  getMessagesTool,
  waitForMessagesTool,
  
  // Management
  getStatusTool,
  clearRoomMessagesTool
];

// Cloud mode lists the same tools, with attachments on send_message, download_attachment and the inclusive attachment
// range deletion (docs/cloud-architecture.md §3.9), ephemeral on create_room (D22), and says in get_messages /
// wait_for_messages that server notices are returned (D18). File mode keeps the list above: those inputs need the
// cloud API, and the file mode has no server notices.
const cloudVariants = new Map([
  [createRoomTool, cloudCreateRoomTool],
  [sendMessageTool, cloudSendMessageTool],
  [getMessagesTool, cloudGetMessagesTool],
  [waitForMessagesTool, cloudWaitForMessagesTool]
]);

export const cloudTools = [
  ...allTools.map(tool => cloudVariants.get(tool) ?? tool),
  downloadAttachmentTool,
  deleteAttachmentsThroughPostTool
];

// Tool handlers map
export const toolHandlers = {
  'agent_communication_list_rooms': handleListRooms,
  'agent_communication_create_room': handleCreateRoom,
  'agent_communication_enter_room': handleEnterRoom,
  'agent_communication_leave_room': handleLeaveRoom,
  'agent_communication_list_room_users': handleListRoomUsers,
  'agent_communication_send_message': handleSendMessage,
  'agent_communication_get_messages': handleGetMessages,
  'agent_communication_wait_for_messages': handleWaitForMessages,
  'agent_communication_download_attachment': handleDownloadAttachment,
  'agent_communication_delete_attachments_through_post': handleDeleteAttachmentsThroughPost,
  'agent_communication_get_status': handleGetStatus,
  'agent_communication_clear_room_messages': handleClearRoomMessages
};