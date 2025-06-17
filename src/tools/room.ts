import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { listRoomsSchema, createRoomSchema, enterRoomSchema, leaveRoomSchema, listRoomUsersSchema } from '../schemas/index.js';

export const listRoomsTool: Tool = {
  name: 'agent_communication_list_rooms',
  description: 'List all available rooms',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
};

export const createRoomTool: Tool = {
  name: 'agent_communication_create_room',
  description: 'Create a new room',
  inputSchema: {
    type: 'object',
    properties: {
      roomName: {
        type: 'string',
        description: 'Name of the room to create'
      },
      description: {
        type: 'string',
        description: 'Optional description for the room'
      }
    },
    required: ['roomName'],
    additionalProperties: false
  }
};

export const enterRoomTool: Tool = {
  name: 'agent_communication_enter_room',
  description: 'Enter a room',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Name of the agent entering the room'
      },
      roomName: {
        type: 'string',
        description: 'Name of the room to enter'
      }
    },
    required: ['agentName', 'roomName'],
    additionalProperties: false
  }
};

export const leaveRoomTool: Tool = {
  name: 'agent_communication_leave_room',
  description: 'Leave a room',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Name of the agent leaving the room'
      },
      roomName: {
        type: 'string',
        description: 'Name of the room to leave'
      }
    },
    required: ['agentName', 'roomName'],
    additionalProperties: false
  }
};

export const listRoomUsersTool: Tool = {
  name: 'agent_communication_list_room_users',
  description: 'List users in a room',
  inputSchema: {
    type: 'object',
    properties: {
      roomName: {
        type: 'string',
        description: 'Name of the room to list users for'
      }
    },
    required: ['roomName'],
    additionalProperties: false
  }
};

export async function handleListRooms(
  args: any,
  roomsAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const result = await roomsAdapter.listRooms();
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}

export async function handleCreateRoom(
  args: any,
  roomsAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = createRoomSchema.parse(args);
  const result = await roomsAdapter.createRoom(validatedArgs);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}

export async function handleEnterRoom(
  args: any,
  roomsAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = enterRoomSchema.parse(args);
  const result = await roomsAdapter.enterRoom(validatedArgs);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}

export async function handleLeaveRoom(
  args: any,
  roomsAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = leaveRoomSchema.parse(args);
  const result = await roomsAdapter.leaveRoom(validatedArgs);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}

export async function handleListRoomUsers(
  args: any,
  roomsAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = listRoomUsersSchema.parse(args);
  const result = await roomsAdapter.listRoomUsers(validatedArgs);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}