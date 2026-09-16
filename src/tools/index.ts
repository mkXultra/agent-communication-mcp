// Room management tools
import {
  listRoomsTool,
  createRoomTool,
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
  handleSendMessage,
  handleGetMessages,
  handleWaitForMessages,
  handleDownloadAttachment
} from './messaging';

export {
  sendMessageTool,
  cloudSendMessageTool,
  getMessagesTool,
  cloudGetMessagesTool,
  waitForMessagesTool,
  cloudWaitForMessagesTool,
  downloadAttachmentTool,
  handleSendMessage,
  handleGetMessages,
  handleWaitForMessages,
  handleDownloadAttachment
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

// Cloud mode lists the same tools, with attachments on send_message, and download_attachment
// (docs/cloud-architecture.md §3.9), and says in get_messages / wait_for_messages that server notices are returned
// (D18). File mode keeps the list above: attachments need the cloud API, and the file mode has no server notices.
const cloudVariants = new Map([
  [sendMessageTool, cloudSendMessageTool],
  [getMessagesTool, cloudGetMessagesTool],
  [waitForMessagesTool, cloudWaitForMessagesTool]
]);

export const cloudTools = [
  ...allTools.map(tool => cloudVariants.get(tool) ?? tool),
  downloadAttachmentTool
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
  'agent_communication_get_status': handleGetStatus,
  'agent_communication_clear_room_messages': handleClearRoomMessages
};