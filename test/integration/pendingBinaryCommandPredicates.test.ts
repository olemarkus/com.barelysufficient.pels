import { describe, expect, it, vi } from 'vitest';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/observer/controlCommandConfirmation';
import type { PendingBinaryCommand } from '../../lib/observer/pendingBinaryCommandTypes';

/**
 * The store owns the in-flight question, in the two forms consumers actually
 * mean. These predicates exist because one answer used to serve both: the
 * planner counted a pending turn-ON, the plan-input producer counted any
 * direction, and a device republished through `planLiveStateMerge` therefore
 * changed what `binaryCommandPending` meant. Pin the distinction here, so the
 * four call sites can stop re-deriving it.
 */
const pending = (overrides: Partial<PendingBinaryCommand> = {}): PendingBinaryCommand => ({
  dispatchState: 'accepted',
  desired: true,
  startedMs: Date.now(),
  ...overrides,
});

describe('PendingBinaryCommandStore in-flight predicates', () => {
  it('separates "a turn-ON is in flight" from "anything is in flight"', () => {
    const store = createPendingBinaryCommandStore({
      'on-1': pending({ desired: true }),
      'off-1': pending({ desired: false }),
    });

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
    const store = createPendingBinaryCommandStore({});

    expect(store.hasActiveCommand('absent')).toBe(false);
    expect(store.hasActiveTurnOn('absent')).toBe(false);
    expect(store.hasActiveTurnOff('absent')).toBe(false);
  });

  it('treats an expired entry as not in flight, and does not evict it', () => {
    // Eviction fires the timeout lifecycle, which belongs to `get` and the
    // reconcile sweep. A predicate a projection may call must not have that
    // side effect — `buildLiveStatePlan` is a projection, not a re-plan.
    const backing = { 'stale-1': pending({ startedMs: Date.now() - 120_000 }) };
    const store = createPendingBinaryCommandStore(backing);

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
    const store = createPendingBinaryCommandStore(backing, { onTimedOut });

    // `recordFailure` early-returns on a turn-OFF, so a pending turn-ON is the
    // direction that actually reaches the reachability backoff.
    expect(store.isBinaryChangeAttributableToPels('ev-1')).toBe(false);

    expect(onTimedOut).not.toHaveBeenCalled();
    expect(backing['ev-1']).toBeDefined();
  });

  it('still attributes an in-flight command and a recently confirmed OFF', () => {
    const onTimedOut = vi.fn();
    const store = createPendingBinaryCommandStore(
      { 'ev-1': pending({ desired: false }) },
      { onTimedOut },
    );
    store.recordConfirmedBinaryCommand({ deviceId: 'ev-2', desired: false });

    expect(store.isBinaryChangeAttributableToPels('ev-1')).toBe(true);
    expect(store.isBinaryChangeAttributableToPels('ev-2')).toBe(true);
    expect(store.isBinaryChangeAttributableToPels('ev-3')).toBe(false);
    expect(onTimedOut).not.toHaveBeenCalled();
  });

  it('leaves the expired entry for the reconcile sweep, which does fire the timeout', () => {
    const onTimedOut = vi.fn();
    const backing = { 'ev-1': pending({ desired: true, startedMs: expiredStartedMs() }) };
    const store = createPendingBinaryCommandStore(backing, { onTimedOut });

    store.isBinaryChangeAttributableToPels('ev-1');
    expect(onTimedOut).not.toHaveBeenCalled();

    syncPendingBinaryCommands({ store, liveDevices: [], source: 'rebuild' });

    expect(onTimedOut).toHaveBeenCalledTimes(1);
    expect(backing['ev-1']).toBeUndefined();
  });
});
