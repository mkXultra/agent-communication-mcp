// wait_for_messages `timeout`: the tool definition (seconds), the internal validators (milliseconds) and the conversion
// between them agree (docs/cloud-architecture.md §5.4: 1..300 seconds, default 30, 0 = until a message arrives).

import { describe, it, expect, vi } from 'vitest';
import { WAIT_CONSTANTS } from '../../../src/features/messaging/constants';
import { MessageValidator, waitForMessagesSchema } from '../../../src/features/messaging/MessageValidator';
import { waitForMessagesInputSchema } from '../../../src/schemas/message.schema';
import { handleWaitForMessages, waitForMessagesTool } from '../../../src/tools/messaging';
import { ValidationError } from '../../../src/errors/AppError';

const base = { agentName: 'test-agent', roomName: 'test-room' };

describe('wait_for_messages timeout', () => {
  it('is defined in seconds from 0 to 300 with a default of 30, 0 waiting until a message arrives', () => {
    const timeout = waitForMessagesTool.inputSchema.properties!.timeout as {
      type: string;
      minimum: number;
      maximum: number;
      default: number;
      description: string;
    };
    expect(timeout).toMatchObject({ type: 'number', minimum: 0, maximum: 300, default: 30 });
    expect(timeout.description).toContain('0 = メッセージが届くまで無期限に待つ（常駐エージェント向け）');
    expect(timeout.maximum * 1000).toBe(WAIT_CONSTANTS.MAX_TIMEOUT);
    expect(timeout.default * 1000).toBe(WAIT_CONSTANTS.DEFAULT_TIMEOUT);
    expect(WAIT_CONSTANTS.NO_TIMEOUT).toBe(0);
  });

  it('is accepted internally as 0 or 1000..300000 ms, or left out', () => {
    for (const timeout of [0, 1000, 30000, 300000]) {
      expect(MessageValidator.validateWaitForMessages({ ...base, timeout })).toEqual({ ...base, timeout });
    }
    expect(MessageValidator.validateWaitForMessages(base)).toEqual(base);
  });

  it('is rejected internally between 0 and 1000 ms, above 300000 ms, when negative and when not whole', () => {
    expect(() => MessageValidator.validateWaitForMessages({ ...base, timeout: 999 })).toThrow(
      "Validation failed for field 'timeout': Timeout must be at least 1000ms, or 0 to wait until a message arrives"
    );
    expect(() => MessageValidator.validateWaitForMessages({ ...base, timeout: 300001 })).toThrow(
      "Validation failed for field 'timeout': Timeout cannot exceed 300000ms"
    );
    expect(() => MessageValidator.validateWaitForMessages({ ...base, timeout: -1000 })).toThrow(ValidationError);
    expect(() => MessageValidator.validateWaitForMessages({ ...base, timeout: 1500.5 })).toThrow(ValidationError);
  });

  it('has the same range in src/schemas, whose default is the tool default', () => {
    for (const timeout of [-1000, -1, 0, 1, 999, 1000, 30000, 300000, 300001, 1500.5]) {
      expect(waitForMessagesInputSchema.safeParse({ ...base, timeout }).success).toBe(
        waitForMessagesSchema.safeParse({ ...base, timeout }).success
      );
    }
    expect(waitForMessagesInputSchema.parse(base).timeout).toBe(WAIT_CONSTANTS.DEFAULT_TIMEOUT);
  });

  it('is converted from seconds to milliseconds by the tool handler, 0 staying 0, and the signal is passed on', async () => {
    const adapter = { waitForMessages: vi.fn().mockResolvedValue({ messages: [], hasNewMessages: false, timedOut: true }) };
    const signal = new AbortController().signal;

    await handleWaitForMessages({ ...base, timeout: 300 }, adapter, signal);
    await handleWaitForMessages({ ...base, timeout: 301 }, adapter);
    await handleWaitForMessages({ ...base, timeout: 0 }, adapter);
    await handleWaitForMessages({ ...base }, adapter);

    expect(adapter.waitForMessages.mock.calls).toEqual([
      [{ ...base, timeout: 300000 }, signal],
      // Rejected by the validator behind the adapter (above 300000 ms).
      [{ ...base, timeout: 301000 }, undefined],
      [{ ...base, timeout: 0 }, undefined],
      [{ ...base, timeout: undefined }, undefined],
    ]);
  });
});
