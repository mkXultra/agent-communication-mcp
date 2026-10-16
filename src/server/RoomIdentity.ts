// MCP-facing room identity: the acting agent name of ONE MCP server instance, remembered per room.
//
// The name is established only by a successful enter_room and lives in this instance only: it is not written to
// disk, not stored as a shared default in cloud room state, and not shared between independent MCP server
// instances, even when they use the same API token. The internal file/cloud services keep taking an explicit
// agentName; this layer supplies the name they are composed with.
//
// Each invocation resolves the name once, at its start, so an entry made while the invocation is in flight cannot
// change the name it acts as. Transitions (entries, switches and leaves of one room) are serialized; the lifetime
// of a wait is not, so a long wait never keeps an entry or a leave from running. A new invocation is refused while
// this instance's own leave of the selected/different name is in flight, before the old name may have left. A wait
// this instance owns is canceled (without consuming the unread messages it would have returned) when the name it
// acts as leaves the room, when enter_room switches the room to another name, or when the server shuts down.

import type { MessagingAdapter } from '../adapters/MessagingAdapter.js';
import type { RoomsAdapter } from '../adapters/RoomsAdapter.js';
import {
  AgentNameNotAllowedError,
  AgentNotInRoomError,
  RoomIdentityClosedError,
  RoomIdentityRequiredError,
  WaitCancelledError,
} from '../errors/index.js';
import {
  enterRoomSchema,
  leaveRoomSchema,
  publicSendMessageInputSchema,
  publicWaitForMessagesInputSchema,
} from '../schemas/index.js';
import { handleEnterRoom, handleLeaveRoom, handleSendMessage, handleWaitForMessages } from '../tools/index.js';
import { linkAbortSignals, settledOrAborted } from '../utils/abort.js';

/**
 * How long a transition gives a wait it canceled to end before it goes on. The abort makes the wait end quickly
 * (and leaves the messages it would have returned unread); the grace only keeps a wait that cannot be interrupted
 * from blocking the transition forever.
 */
const WAIT_CLEANUP_GRACE_MS = 2000;

type ToolResult = { content: Array<{ type: string; text: string }> };

/** A wait_for_messages call this instance started and can end by name. */
interface OwnedWait {
  abort: (reason: unknown) => void;
  /** Settles when the call is over, however it ends. */
  settled: Promise<void>;
}

/** The key of a room x agent wait: the same room and agent name, whatever the connection. */
function waitKey(roomName: string, agentName: string): string {
  return `${roomName}\u0000${agentName}`;
}

/** Whether `value` carries `key` at all (an explicit agentName is rejected even when it would match). */
function hasProperty(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

/** The original failure with a cleanup failure appended, so a best-effort cleanup that fails is not hidden. */
function withCleanupFailure(error: unknown, cleanup: string): Error {
  const suffix = ` (cleanup also failed: ${cleanup})`;
  if (error instanceof Error) {
    error.message += suffix;
    return error;
  }
  return new Error(`${String(error)}${suffix}`);
}

export class RoomIdentity {
  /** roomName -> selected agent name. One per room, per MCP server instance. */
  private readonly names = new Map<string, string>();
  /**
   * Rooms whose admission is suspended while this instance runs its own leave. New sends/waits are refused for a
   * suspended room even though `names` may still hold the old name: the leave is already in flight, so the old name
   * may no longer be usable. It is distinct from `names` so shutdown keeps owning the binding for cleanup.
   */
  private readonly suspended = new Set<string>();
  /** Terminal after shutdown: a later continuation must not commit a binding or start owned work. */
  private closed = false;
  /** One transition per room at a time; transitions of different rooms do not wait for each other. */
  private readonly transitions = new Map<string, Promise<unknown>>();
  /** wait_for_messages calls this instance started, by room x agent, so a transition can end the matching ones. */
  private readonly waits = new Map<string, Set<OwnedWait>>();

  constructor(
    private readonly rooms: RoomsAdapter,
    private readonly messaging: MessagingAdapter,
  ) {}

  /** The name enter_room selected for `roomName` on this instance, or undefined when there is none. */
  selectedName(roomName: string): string | undefined {
    return this.names.get(roomName);
  }

  /** The room x name pairs this instance currently owns, for scoping instance-local cleanup (e.g. cloud sockets). */
  ownedIdentities(): Array<{ roomName: string; agentName: string }> {
    return [...this.names].map(([roomName, agentName]) => ({ roomName, agentName }));
  }

  /**
   * enter_room, then remember its name for this room. A failed entry writes no binding; a same-name entry reuses the
   * existing one, keeping the idempotent entry/profile behaviour. A different name switches the room: the old name is
   * left and its waits are ended before the new binding is committed.
   */
  async enterRoom(args: unknown): Promise<ToolResult> {
    const validated = enterRoomSchema.parse(args);
    return this.withTransition(validated.roomName, async () => {
      // A queued entry that resumes after shutdown must not join or commit.
      if (this.closed) throw new RoomIdentityClosedError();
      const current = this.names.get(validated.roomName);
      if (current === validated.agentName) {
        // Same-name re-entry: idempotent, and the binding (and the waits) stay as they are.
        const result = await handleEnterRoom(validated, this.rooms);
        if (this.closed) throw new RoomIdentityClosedError();
        this.names.set(validated.roomName, validated.agentName);
        this.suspended.delete(validated.roomName);
        return result;
      }
      if (current === undefined) {
        // First entry of this room on this instance: bind only after the entry succeeds, and only while the instance
        // is still open. A first entry adds no membership read to its normal path, so a shutdown that races the join
        // does not clean the membership up (normal shutdown does not leave rooms either); a switch below knows whether
        // it introduced the replacement and cleans up only then.
        return this.enterAndCommit(validated);
      }
      return this.switchIdentity(validated, current);
    });
  }

  /**
   * send_message as the name this instance selected for the room. The name is resolved once, at the start, and passed
   * explicitly, so the invocation keeps acting as it even if the binding changes while it is in flight.
   */
  async sendMessage(args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (hasProperty(args, 'agentName')) {
      throw new AgentNameNotAllowedError('send_message');
    }
    const parsed = publicSendMessageInputSchema.parse(args);
    const agentName = this.resolveName(parsed.roomName);
    return handleSendMessage({ ...parsed, agentName }, this.messaging, signal);
  }

  /**
   * wait_for_messages as the name this instance selected for the room. The name is resolved once, at the start, and
   * the call is registered so that a later switch, leave or shutdown can cancel it without consuming the messages it
   * would have returned.
   */
  async waitForMessages(args: unknown, requestSignal: AbortSignal): Promise<ToolResult> {
    if (hasProperty(args, 'agentName')) {
      throw new AgentNameNotAllowedError('wait_for_messages');
    }
    const parsed = publicWaitForMessagesInputSchema.parse(args);
    const agentName = this.resolveName(parsed.roomName);
    const link = linkAbortSignals(requestSignal);
    const key = waitKey(parsed.roomName, agentName);
    const wait: OwnedWait = { abort: link.abort, settled: Promise.resolve() };
    const result = handleWaitForMessages({ ...parsed, agentName }, this.messaging, link.signal);
    wait.settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.addWait(key, wait);
    try {
      return await result;
    } finally {
      this.removeWait(key, wait);
      link.dispose();
    }
  }

  /**
   * leave_room. Leaving the name this instance selected for the room clears the room's binding and ends its waits;
   * leaving another name leaves the selected one (and its waits) untouched.
   */
  async leaveRoom(args: unknown): Promise<ToolResult> {
    const validated = leaveRoomSchema.parse(args);
    return this.withTransition(validated.roomName, async () => {
      if (this.closed) throw new RoomIdentityClosedError();
      const selected = this.names.get(validated.roomName) === validated.agentName;
      // Leaving the selected name suspends admission for the room BEFORE the leave starts: the old name may be gone
      // as soon as the leave takes effect, even while its response is still in flight. Leaving another name is
      // unaffected. `names` keeps the binding for shutdown cleanup while suspended.
      if (selected) this.suspended.add(validated.roomName);
      let result: ToolResult;
      try {
        result = await handleLeaveRoom(validated, this.rooms);
      } catch (error) {
        // The leave failed. Restore admission only if the selected name is provably still online; otherwise clear the
        // binding so an explicit re-entry is required.
        if (selected) {
          if ((await this.membership(validated.roomName, validated.agentName)) === 'online') {
            this.suspended.delete(validated.roomName);
          } else {
            this.names.delete(validated.roomName);
            await this.cancelWaits(
              validated.roomName,
              validated.agentName,
              new WaitCancelledError('the agent could not leave the room on this MCP connection'),
            );
            // The leave may have taken effect server-side, so the cleared binding no longer carries the socket to
            // shutdown: release this instance's connection for the pair now.
            this.rooms.releaseSocket(validated.roomName, validated.agentName);
          }
        }
        throw error;
      }
      if (selected) {
        this.names.delete(validated.roomName);
        await this.cancelWaits(
          validated.roomName,
          validated.agentName,
          new WaitCancelledError('the agent left the room on this MCP connection'),
        );
      }
      return result;
    });
  }

  /**
   * Shutdown: drop every binding and end every wait this instance owns. The waits end first, while the connections
   * are still open, so a cloud wait can still record the read position of what it passed over.
   */
  async shutdown(): Promise<void> {
    // Terminal, set before clearing or awaiting anything so a late entry continuation cannot commit afterwards.
    this.closed = true;
    this.names.clear();
    const waits = [...this.waits.values()].flatMap((set) => [...set]);
    for (const wait of waits) wait.abort(new WaitCancelledError('the server is shutting down'));
    if (waits.length === 0) return;
    await settledOrAborted(
      Promise.all(waits.map((wait) => wait.settled)),
      AbortSignal.timeout(WAIT_CLEANUP_GRACE_MS),
    );
  }

  /**
   * The name enter_room selected for `roomName` on this instance, or undefined when there is none. The caller
   * snapshots this synchronously at the start of its invocation, so a later entry cannot change the name it acts as.
   */
  private resolveName(roomName: string): string {
    // A suspended room is mid-transition: the old name may already be gone, so a new invocation must not act as it.
    const agentName = this.suspended.has(roomName) ? undefined : this.names.get(roomName);
    if (agentName === undefined) {
      throw new RoomIdentityRequiredError(roomName);
    }
    return agentName;
  }

  /**
   * Runs handleEnterRoom and commits the binding only while the instance is open. A rejection (including the join
   * performing its side effect and then failing, and a join that resolves after shutdown) is left to the caller to
   * clean up, so a replacement introduced by a switch is always handled by that switch's single cleanup site.
   *
   * Shutdown observed before the join is refused here, without calling the rooms adapter: a continuation that resumes
   * after shutdown must not start fresh replacement work. `onJoinInitiated` fires immediately before the join starts,
   * so a switch can tell a join this attempt actually began from one it refused before starting.
   */
  private async enterAndCommit(
    validated: { agentName: string; roomName: string; profile?: unknown },
    onJoinInitiated?: () => void,
  ): Promise<ToolResult> {
    if (this.closed) throw new RoomIdentityClosedError();
    onJoinInitiated?.();
    const result = await handleEnterRoom(validated, this.rooms);
    if (this.closed) throw new RoomIdentityClosedError();
    this.names.set(validated.roomName, validated.agentName);
    // A successful explicit entry is what restores admission after a transition cleared the binding.
    this.suspended.delete(validated.roomName);
    return result;
  }

  /**
   * Switch the room from `current` to the name `validated` asks for: leave the old name, invalidate the local
   * selection, end the old waits, join the new one, and commit only if that succeeded. The old binding survives only
   * while the old name is still usable. The replacement is only cleaned up on failure when this attempt brought it
   * online (an already-online name belongs to another connection and must be left alone).
   */
  private async switchIdentity(validated: { agentName: string; roomName: string; profile?: unknown }, current: string): Promise<ToolResult> {
    const { roomName, agentName } = validated;
    // Suspend admission BEFORE the old-name leave starts, so a send/wait admitted while its response is in flight
    // cannot act as a name the leave has already removed. `names` keeps the binding for shutdown cleanup.
    this.suspended.add(roomName);
    try {
      await handleLeaveRoom({ agentName: current, roomName }, this.rooms);
    } catch (error) {
      // The leave failed. Keep the old binding (and restore admission) only if the old name is provably still
      // online; an unreadable membership is not proof, so clear it and require an explicit re-entry.
      if ((await this.membership(roomName, current)) !== 'online') {
        this.names.delete(roomName);
        await this.cancelWaits(roomName, current, new WaitCancelledError('the room identity could not be switched'));
        // The old-name leave may have taken effect server-side, so the cleared binding no longer carries the socket
        // to shutdown: release this instance's connection for the old name now.
        this.rooms.releaseSocket(roomName, current);
      } else {
        this.suspended.delete(roomName);
      }
      throw error;
    }
    // The old name is gone: the local selection is no longer usable, so drop it before any further await. New
    // sends/waits resolve no name (and are refused) until the replacement commits, and a wait admitted here cannot
    // escape the cancellation below.
    this.names.delete(roomName);
    await this.cancelWaits(roomName, current, new WaitCancelledError('the room identity is changing'));
    // Shutdown began while the old name's leave or its cancellation was in flight: do not start a fresh replacement
    // precheck, join, or cleanup. This check is outside the try below, so no replacement cleanup is attempted either.
    if (this.closed) throw new RoomIdentityClosedError();
    // Cleanup ownership is only inferred from a readable absence/offline precheck. An unreadable read is not proof
    // that this attempt introduces the replacement, so it must not evict a member that is online elsewhere.
    const introducedByThisAttempt = (await this.membership(roomName, agentName)) === 'offline';
    let joinInitiated = false;
    try {
      return await this.enterAndCommit(validated, () => {
        joinInitiated = true;
      });
    } catch (error) {
      // The old name has left, so the old binding must not survive; require an explicit successful re-entry. Clean up
      // the replacement exactly once when this attempt introduced it AND actually started its join: this covers a join
      // that rejected (including after its membership side effect, and while shutting down) and a join that resolved
      // after shutdown, and appends a genuine cleanup failure. An unreadable precheck claims no ownership, and a join
      // refused before starting (shutdown observed during the precheck) leaves nothing to clean up.
      this.names.delete(roomName);
      const cleanup =
        introducedByThisAttempt && joinInitiated ? await this.bestEffortLeave(roomName, agentName) : undefined;
      throw cleanup === undefined ? error : withCleanupFailure(error, cleanup);
    }
  }

  /**
   * The membership a room reports for `agentName`: `online` when it is a connected member, `offline` when the room
   * was read and the name is absent or offline, `unknown` when the room's members could not be read. Unknown is not
   * absence: cleanup ownership is only inferred from a readable `offline` state.
   */
  private async membership(roomName: string, agentName: string): Promise<'online' | 'offline' | 'unknown'> {
    let users: Array<{ name: string; status: string }>;
    try {
      ({ users } = await this.rooms.listRoomUsers({ roomName }));
    } catch {
      return 'unknown';
    }
    return users.some((user) => user.name === agentName && user.status === 'online') ? 'online' : 'offline';
  }

  /**
   * Best-effort cleanup of a replacement that may have partially joined: leaving it, or nothing when it never joined.
   * Returns the failure message when the leave itself failed in a way that leaves state behind, otherwise undefined.
   */
  private async bestEffortLeave(roomName: string, agentName: string): Promise<string | undefined> {
    try {
      await handleLeaveRoom({ agentName, roomName }, this.rooms);
      return undefined;
    } catch (error) {
      // Not being a member is not a cleanup failure: the replacement never joined (or already left).
      if (error instanceof AgentNotInRoomError) return undefined;
      return error instanceof Error ? error.message : String(error);
    }
  }

  private addWait(key: string, wait: OwnedWait): void {
    let set = this.waits.get(key);
    if (!set) {
      set = new Set();
      this.waits.set(key, set);
    }
    set.add(wait);
  }

  private removeWait(key: string, wait: OwnedWait): void {
    const set = this.waits.get(key);
    if (!set) return;
    set.delete(wait);
    if (set.size === 0) this.waits.delete(key);
  }

  /** Ends every wait this instance owns for `roomName` x `agentName`, leaving their unread messages unread. */
  private async cancelWaits(roomName: string, agentName: string, reason: WaitCancelledError): Promise<void> {
    const waits = [...(this.waits.get(waitKey(roomName, agentName)) ?? [])];
    for (const wait of waits) wait.abort(reason);
    if (waits.length === 0) return;
    await settledOrAborted(
      Promise.all(waits.map((wait) => wait.settled)),
      AbortSignal.timeout(WAIT_CLEANUP_GRACE_MS),
    );
  }

  /** Runs `task` after every earlier transition of the same room; a failure releases the room for the next one. */
  private async withTransition<T>(roomName: string, task: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(roomName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.transitions.set(roomName, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.transitions.get(roomName) === tail) this.transitions.delete(roomName);
    }
  }
}
