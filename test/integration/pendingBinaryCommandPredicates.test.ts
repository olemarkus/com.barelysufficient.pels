import { describe, expect, it } from 'vitest';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
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
  pendingMs: 30_000,
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
    const backing = { 'stale-1': pending({ startedMs: Date.now() - 120_000, pendingMs: 30_000 }) };
    const store = createPendingBinaryCommandStore(backing);

    expect(store.hasActiveCommand('stale-1')).toBe(false);
    expect(store.hasActiveTurnOn('stale-1')).toBe(false);
    expect(backing['stale-1']).toBeDefined();
  });
});
