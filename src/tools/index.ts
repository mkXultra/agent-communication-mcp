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
  getMessagesTool,
  handleSendMessage,
  handleGetMessages
} from './messaging';

export {
  sendMessageTool,
  getMessagesTool,
  handleSendMessage,
  handleGetMessages
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
  
  // Management
  getStatusTool,
  clearRoomMessagesTool
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
  'agent_communication_get_status': handleGetStatus,
  'agent_communication_clear_room_messages': handleClearRoomMessages
};