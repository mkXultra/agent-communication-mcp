// wait_for_messages `mentionsOnly`: the tool definition, the internal validators and the tool handler agree (a boolean,
// false when left out, like the field of get_messages). The waiting itself: WaitForMessages.test.ts (file mode),
// tests/e2e/wait-for-messages.test.ts (both modes) and tests/cloud (WebSocket and long polling).

import { describe, it, expect, vi } from 'vitest';
import { ZodError } from 'zod';
import { MessageValidator, getMessagesSchema, waitForMessagesSchema } from '../../../src/features/messaging/MessageValidator';
import { waitForMessagesInputSchema } from '../../../src/schemas/message.schema';
import { handleWaitForMessages, waitForMessagesTool } from '../../../src/tools/messaging';
import { ValidationError } from '../../../src/errors/AppError';

const base = { agentName: 'test-agent', roomName: 'test-room' };

describe('wait_for_messages mentionsOnly', () => {
  it('is defined as an optional boolean that defaults to false', () => {
    expect(waitForMessagesTool.inputSchema.properties!.mentionsOnly).toEqual({
      type: 'boolean',
      description: 'Only return messages that mention agentName; other new messages are marked read without being returned',
      default: false
    });
    expect(waitForMessagesTool.inputSchema.required).toEqual(['agentName', 'roomName']);
  });

  it('is accepted internally as a boolean and is false when left out, in both schemas', () => {
    expect(MessageValidator.validateWaitForMessages(base).mentionsOnly).toBe(false);
    expect(MessageValidator.validateWaitForMessages({ ...base, mentionsOnly: true }).mentionsOnly).toBe(true);
    expect(MessageValidator.validateWaitForMessages({ ...base, mentionsOnly: false }).mentionsOnly).toBe(false);
    expect(waitForMessagesInputSchema.parse(base).mentionsOnly).toBe(false);
    expect(waitForMessagesInputSchema.parse({ ...base, mentionsOnly: true }).mentionsOnly).toBe(true);
    // The same field as get_messages
    expect(getMessagesSchema.parse({ roomName: base.roomName }).mentionsOnly).toBe(false);
  });

  it('is rejected internally when it is not a boolean', () => {
    expect(() => MessageValidator.validateWaitForMessages({ ...base, mentionsOnly: 'true' })).toThrow(
      "Validation failed for field 'mentionsOnly': Expected boolean, received string"
    );
    expect(() => MessageValidator.validateWaitForMessages({ ...base, mentionsOnly: 1 })).toThrow(ValidationError);
    for (const mentionsOnly of ['true', 1, null]) {
      expect(waitForMessagesSchema.safeParse({ ...base, mentionsOnly }).success).toBe(false);
      expect(waitForMessagesInputSchema.safeParse({ ...base, mentionsOnly }).success).toBe(false);
    }
  });

  it('is parsed by the tool handler with the schema and passed on to the adapter, false when not given', async () => {
    const adapter = { waitForMessages: vi.fn().mockResolvedValue({ messages: [], hasNewMessages: false, timedOut: true }) };
    const signal = new AbortController().signal;

    await handleWaitForMessages({ ...base, timeout: 0, mentionsOnly: true }, adapter, signal);
    await handleWaitForMessages({ ...base, timeout: 5, mentionsOnly: false }, adapter);
    await handleWaitForMessages({ ...base, timeout: 5 }, adapter);

    expect(adapter.waitForMessages.mock.calls).toEqual([
      [{ ...base, timeout: 0, mentionsOnly: true }, signal],
      [{ ...base, timeout: 5000, mentionsOnly: false }, undefined],
      [{ ...base, timeout: 5000, mentionsOnly: false }, undefined],
    ]);
  });

  it('is rejected by the tool handler when it is not a boolean, before the adapter is called', async () => {
    const adapter = { waitForMessages: vi.fn().mockResolvedValue({ messages: [], hasNewMessages: false, timedOut: true }) };

    for (const mentionsOnly of ['true', 1, null, {}]) {
      const error = await handleWaitForMessages({ ...base, timeout: 5, mentionsOnly }, adapter).then(() => undefined, (e: unknown) => e);
      // The same error as the schema parse of the other tool handlers (the MCP server answers it with VALIDATION_ERROR)
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual([expect.objectContaining({ path: ['mentionsOnly'], code: 'invalid_type', expected: 'boolean' })]);
    }
    expect(adapter.waitForMessages).not.toHaveBeenCalled();
  });
});
