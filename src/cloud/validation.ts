// Agent Communication MCP Server - file-mode compatible input checks for cloud mode
// The MCP tool schemas (src/schemas) let some inputs through that the file-mode services reject later
// (agent names are only length-checked there, profile limits live in PresenceService). These helpers
// reproduce those checks with the same ValidationError messages so both modes fail the same way.

import { ValidationError } from '../errors/index.js';

export const NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;
export const NAME_MAX_LENGTH = 50;

/** docs/api.yaml `RoomName` / `AgentName`: 1-50 characters of `[a-zA-Z0-9-_]`. */
export function isValidName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= NAME_MAX_LENGTH && NAME_PATTERN.test(value);
}

/** Same checks and messages as RoomService.validateRoomName. */
export function roomNameValidationError(roomName: unknown): ValidationError | null {
  if (!roomName || typeof roomName !== 'string') {
    return new ValidationError('roomName', 'Room name is required and must be a string');
  }
  if (roomName.length > NAME_MAX_LENGTH) {
    return new ValidationError('roomName', 'Room name cannot exceed 50 characters');
  }
  if (!NAME_PATTERN.test(roomName)) {
    return new ValidationError('roomName', 'Room name can only contain alphanumeric characters, hyphens, and underscores');
  }
  return null;
}

/** Same checks and messages as PresenceService.validateAgentName. */
export function agentNameValidationError(agentName: unknown): ValidationError | null {
  if (!agentName || typeof agentName !== 'string') {
    return new ValidationError('agentName', 'Agent name is required and must be a string');
  }
  if (agentName.length > NAME_MAX_LENGTH) {
    return new ValidationError('agentName', 'Agent name cannot exceed 50 characters');
  }
  if (!NAME_PATTERN.test(agentName)) {
    return new ValidationError('agentName', 'Agent name can only contain alphanumeric characters, hyphens, and underscores');
  }
  return null;
}

/**
 * Same checks and messages as PresenceService.validateProfile (only applied to a truthy profile there).
 * The limits are agora docs/api.yaml `AgentProfile`, counted in code points as agora counts them. The enter_room
 * tool schema now carries them as well (0.7.0), so an MCP call fails before this; this stays the check for
 * callers that use the adapter directly.
 */
export function profileValidationError(profile: unknown): ValidationError | null {
  if (!profile) return null;
  if (typeof profile !== 'object') {
    return new ValidationError('profile', 'Profile must be an object');
  }
  const p = profile as Record<string, unknown>;

  if (p.role !== undefined) {
    if (typeof p.role !== 'string') return new ValidationError('profile.role', 'Profile role must be a string');
    if (Array.from(p.role).length > 100) {
      return new ValidationError('profile.role', 'Profile role cannot exceed 100 characters');
    }
  }
  if (p.description !== undefined) {
    if (typeof p.description !== 'string') {
      return new ValidationError('profile.description', 'Profile description must be a string');
    }
    if (Array.from(p.description).length > 500) {
      return new ValidationError('profile.description', 'Profile description cannot exceed 500 characters');
    }
  }
  if (p.capabilities !== undefined) {
    if (!Array.isArray(p.capabilities)) {
      return new ValidationError('profile.capabilities', 'Profile capabilities must be an array');
    }
    if (p.capabilities.length > 50) {
      return new ValidationError('profile.capabilities', 'Profile capabilities cannot exceed 50 items');
    }
    for (const capability of p.capabilities) {
      if (typeof capability !== 'string') {
        return new ValidationError('profile.capabilities', 'Each capability must be a string');
      }
      if (Array.from(capability).length > 100) {
        return new ValidationError('profile.capabilities', 'Each capability cannot exceed 100 characters');
      }
    }
  }
  if (p.metadata !== undefined && (typeof p.metadata !== 'object' || p.metadata === null)) {
    return new ValidationError('profile.metadata', 'Profile metadata must be an object');
  }
  return null;
}

/** docs/api.yaml `format: uuid` of attachment IDs (any version, either case, as agora accepts them). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** download_attachment's `attachmentId` and `savePath` (cloud mode only: there is no file-mode counterpart). */
export function downloadParamsValidationError(attachmentId: unknown, savePath: unknown): ValidationError | null {
  if (typeof attachmentId !== 'string' || !UUID_PATTERN.test(attachmentId)) {
    return new ValidationError('attachmentId', 'Attachment ID must be a UUID');
  }
  if (typeof savePath !== 'string' || savePath === '') {
    return new ValidationError('savePath', 'Save path is required and must be a string');
  }
  return null;
}

/** Same checks and messages as RoomService.validateDescription. */
export function descriptionValidationError(description: unknown): ValidationError | null {
  if (description === undefined) return null;
  if (typeof description !== 'string') return new ValidationError('description', 'Description must be a string');
  if (description.length > 200) return new ValidationError('description', 'Description cannot exceed 200 characters');
  return null;
}
