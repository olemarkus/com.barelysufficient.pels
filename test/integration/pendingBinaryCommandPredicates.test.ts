import { describe, expect, it, vi } from 'vitest';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import type { PendingBinaryCommand } from '../../lib/ports/pendingBinaryCommand';
import { fixedConfirmationWindows } from '../helpers/confirmationWindows';

/**
 * The store owns the in-flight question, in the two forms consumers actually
 * mean. These predicates exist because one answer used to serve both: the
 * planner counted a pending turn-ON, the plan-input producer counted any
 * direction, and a device republished through the (since removed) live-state
 * merge therefore changed what `binaryCommandPending` meant. Pin the distinction here, so the
 * four call sites can stop re-deriving it.
 */
const pending = (overrides: Partial<PendingBinaryCommand> = {}): PendingBinaryCommand => ({
  dispatchState: 'accepted',
  desired: true,
  startedMs: Date.now(),
  confirmationWindowMs: CONTROL_COMMAND_CONFIRMATION_MS,
  ...overrides,
});

describe('PendingBinaryCommandStore in-flight predicates', () => {
  it('separates "a turn-ON is in flight" from "anything is in flight"', () => {
    const store = createPendingBinaryCommandStore({
      'on-1': pending({ desired: true }),
      'off-1': pending({ desired: false }),
    }, fixedConfirmationWindows);

    expect(store.hasActiveTurnOn('on-1')).toBe(true);
    expect(store.hasActiveTurnOff('on-1')).toBe(false);
    expect(store.hasActiveCommand('on-1')).toBe(true);

    // The case the single shared field got wrong: a device on its way OFF is
    // mid-actuation, but it is not resuming.
    expect(store.hasActiveTurnOn('off-1')).toBe(false);
    expect(store.hasActiveTurnOff('off-1')).toBe(true);
    expect(store.hasActiveCommand('off-1')).toBe(true);
  });

  it('answers false for a device with no entry', () => {
    const store = createPendingBinaryCommandStore({}, fixedConfirmationWindows);

    expect(store.hasActiveCommand('absent')).toBe(false);
    expect(store.hasActiveTurnOn('absent')).toBe(false);
    expect(store.hasActiveTurnOff('absent')).toBe(false);
  });

  it('treats an expired entry as not in flight, and does not evict it', () => {
    // Eviction fires the timeout lifecycle, which belongs to `get` and the
    // reconcile sweep. A predicate a read path may call must not have that
    // side effect — asking is not commanding.
    const backing = { 'stale-1': pending({ startedMs: Date.now() - 120_000 }) };
    const store = createPendingBinaryCommandStore(backing, fixedConfirmationWindows);

    expect(store.hasActiveCommand('stale-1')).toBe(false);
    expect(store.hasActiveTurnOn('stale-1')).toBe(false);
    expect(backing['stale-1']).toBeDefined();
  });
});

/**
 * The provenance question is asked on the OBSERVATION path — every
 * `observedControlStateChanged` event reaches
 * `isBinaryChangeAttributableToPels` through
 * `setup/externalOffHoldDetection.ts`. It is a query, so it must not command:
 * evicting there mutates the shared backing record and fires `onTimedOut`,
 * which `createBinaryCommandReachability` turns into a reachability failure, a
 * retry backoff and a `requestRebuild()`. Expiring a command belongs to `get`
 * and the reconcile sweep — which is what the third case pins, so the fix
 * cannot be mistaken for dropping the timeout.
 */
/** A start stamp the confirmation window has definitively passed. */
const expiredStartedMs = (): number => Date.now() - (CONTROL_COMMAND_CONFIRMATION_MS + 30_000);

describe('PendingBinaryCommandStore provenance predicate', () => {
  it('does not fire the timeout lifecycle when asked about an expired turn-ON', () => {
    const onTimedOut = vi.fn();
    const backing = { 'ev-1': pending({ desired: true, startedMs: expiredStartedMs() }) };
    const store = createPendingBinaryCommandStore(backing, fixedConfirmationWindows, { onTimedOut });

    // `recordFailure` early-returns on a turn-OFF, so a pending turn-ON is the
    // direction that actually reaches the reachability backoff.
    expect(store.isBinaryChangeAttributableToPels('ev-1')).toBe(false);

    expect(onTimedOut).not.toHaveBeenCalled();
    expect(backing['ev-1']).toBeDefined();
  });

  it('still attributes an in-flight command and a recently confirmed OFF', () => {
    const onTimedOut = vi.fn();
    const store = createPendingBinaryCommandStore(
      { 'ev-1': pending({ desired: false }) }, fixedConfirmationWindows,
      { onTimedOut },
    );
    store.recordConfirmedBinaryCommand('ev-2', false);

    expect(store.isBinaryChangeAttributableToPels('ev-1')).toBe(true);
    expect(store.isBinaryChangeAttributableToPels('ev-2')).toBe(true);
    expect(store.isBinaryChangeAttributableToPels('ev-3')).toBe(false);
    expect(onTimedOut).not.toHaveBeenCalled();
  });

  it('leaves the expired entry for the reconcile sweep, which does fire the timeout', () => {
    const onTimedOut = vi.fn();
    const backing = { 'ev-1': pending({ desired: true, startedMs: expiredStartedMs() }) };
    const store = createPendingBinaryCommandStore(backing, fixedConfirmationWindows, { onTimedOut });

    store.isBinaryChangeAttributableToPels('ev-1');
    expect(onTimedOut).not.toHaveBeenCalled();

    syncPendingBinaryCommands(store, [], 'rebuild');

    expect(onTimedOut).toHaveBeenCalledTimes(1);
    expect(backing['ev-1']).toBeUndefined();
  });
});

describe('PendingBinaryCommandStore confirmation window', () => {
  it('gives a command its device window for its direction when recorded, and keeps it after the window changes', () => {
    const backing: Record<string, PendingBinaryCommand> = {};
    let windowMs = 30_000;
    const unconfirmed = vi.fn();
    const windowFor = vi.fn((_deviceId: string, _desired: boolean, _nowMs: number) => windowMs);
    const store = createPendingBinaryCommandStore(backing, { windowMs: windowFor, unconfirmed });
    const startedMs = Date.now();
    store.record('relay', { desired: true, startedMs });
    windowMs = CONTROL_COMMAND_CONFIRMATION_MS;

    expect(windowFor).toHaveBeenCalledWith('relay', true, startedMs);
    expect(backing.relay?.confirmationWindowMs).toBe(30_000);
    expect(store.hasActiveCommand('relay')).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(startedMs + 30_000);
    expect(store.hasActiveCommand('relay')).toBe(false);
    vi.restoreAllMocks();
  });

  it('reports a command that timed out to the owner of its window, with the window it took', () => {
    const backing: Record<string, PendingBinaryCommand> = {};
    const unconfirmed = vi.fn();
    const onTimedOut = vi.fn();
    const store = createPendingBinaryCommandStore(backing, { windowMs: () => 30_000, unconfirmed }, { onTimedOut });
    const startedMs = Date.now() - 31_000;
    store.record('relay', { desired: true, startedMs });
    store.recordDispatchAccepted('relay', { deviceId: 'relay', desired: true });

    syncPendingBinaryCommands(store, [], 'rebuild');

    expect(unconfirmed).toHaveBeenCalledWith('relay');
    expect(onTimedOut).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'relay', desired: true }));
    expect(store.peek('relay')).toBeUndefined();
  });

  it('reports nothing for a command confirmed within its window', () => {
    const backing: Record<string, PendingBinaryCommand> = {};
    const unconfirmed = vi.fn();
    const store = createPendingBinaryCommandStore(backing, { windowMs: () => 30_000, unconfirmed });
    const startedMs = Date.now() - 1_000;
    store.record('relay', { desired: true, startedMs });
    store.recordDispatchAccepted('relay', { deviceId: 'relay', desired: true });

    syncPendingBinaryCommands(store, [{ id: 'relay', name: 'Relay', binaryCommandConfirmation: {
      state: 'observed', observedValue: true, observedAtMs: startedMs + 300,
    } }], 'realtime_capability');

    expect(unconfirmed).not.toHaveBeenCalled();
    expect(store.peek('relay')).toBeUndefined();
  });
});
