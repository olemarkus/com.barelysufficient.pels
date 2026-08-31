import { describe, expect, it } from 'vitest';
import { syncSteppedCommands } from '../../lib/executor/syncSteppedCommands';
import type { SteppedSettleDevice } from '../../lib/observer/steppedSettleSnapshot';
import { STEPPED_LOAD_COMMAND_STALE_MS } from '../../lib/executor/steppedCommandState';
import { steppedStoresForTest } from '../helpers/steppedStores';

const device = (overrides: Partial<SteppedSettleDevice> = {}): SteppedSettleDevice => ({
  id: 'dev-1',
  nativeSteppedControlEnabled: false,
  lowestActiveStepId: 'low',
  observedOn: true,
  steppedCommandConfirmation: { state: 'unavailable' },
  ...overrides,
});

/**
 * The settle pass is where a stepped command reaches a conclusion. What these
 * pin is that the conclusion follows an OBSERVATION — nothing here builds a
 * plan, and the store is untouched until a device says something.
 */
describe('syncSteppedCommands', () => {
  it('confirms a command when the device reports the rung that was asked for', () => {
    const { store, reportedStore } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    const changed = syncSteppedCommands({
      store,
      reportedStore,
      devices: [device({
        steppedCommandConfirmation: { state: 'observed', observedStepId: 'high', observedAtMs: 1_500 },
      })],
      nowMs: 1_500,
    });

    expect(changed).toBe(true);
    expect(store.getDesired('dev-1')).toMatchObject({ status: 'success', pending: false });
  });

  it('concludes nothing when the device has said nothing about a rung', () => {
    const { store, reportedStore } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    syncSteppedCommands({ store, reportedStore, devices: [device()], nowMs: 1_500 });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'pending', pending: true });
  });

  it('does not confirm a command against a different rung than the one asked for', () => {
    const { store, reportedStore } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    syncSteppedCommands({
      store,
      reportedStore,
      devices: [device({
        steppedCommandConfirmation: { state: 'observed', observedStepId: 'low', observedAtMs: 1_500 },
      })],
      nowMs: 1_500,
    });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'pending' });
  });

  it('lapses an unanswered command once its pending window has passed', () => {
    const { store, reportedStore } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    syncSteppedCommands({
      store,
      reportedStore,
      devices: [device()],
      nowMs: 1_000 + STEPPED_LOAD_COMMAND_STALE_MS,
    });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'stale', pending: false });
  });

  it('ends the command session when the on-session ends', () => {
    const { store, reportedStore } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    // The edge needs both samples: the pass that sees ON, then the one that
    // sees OFF. A single OFF sample concludes nothing about a session it never
    // saw running.
    syncSteppedCommands({ store, reportedStore, devices: [device({ observedOn: true })], nowMs: 1_100 });
    syncSteppedCommands({ store, reportedStore, devices: [device({ observedOn: false })], nowMs: 1_200 });

    expect(store.getDesired('dev-1')).toBeUndefined();
    expect(store.hasPriorStepCommand('dev-1')).toBe(false);
  });

  it('is reached when a stepped command is the ONLY thing in flight', () => {
    // The plan service guards the target/binary sweeps on their own pending
    // predicates, and neither speaks for this axis. Running the stepped sweep
    // after that guard left a native rung or an on→off observation unsettled
    // until some later meter-driven rebuild — on an irregular Flow feed, long
    // enough to suppress retries for a device that had already reported.
    const { store, reportedStore } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });
    expect(store.hasTrackedState()).toBe(true);

    const changed = syncSteppedCommands({
      store,
      reportedStore,
      devices: [device({
        steppedCommandConfirmation: { state: 'observed', observedStepId: 'high', observedAtMs: 1_500 },
      })],
      nowMs: 1_500,
    });

    expect(changed).toBe(true);
    expect(store.isStepCommandPending('dev-1')).toBe(false);
  });

  it('reports nothing tracked on a fresh store, so the sweep can be skipped', () => {
    const { store, reportedStore } = steppedStoresForTest();
    expect(store.hasTrackedState()).toBe(false);
    expect(reportedStore.hasAny()).toBe(false);
  });

  it('drops a Flow report once the device reports its own rung natively', () => {
    const { store, reportedStore } = steppedStoresForTest();
    reportedStore.record({ deviceId: 'dev-1', stepId: 'low', reportedAtMs: 1_000 });

    syncSteppedCommands({
      store,
      reportedStore,
      devices: [device({ nativeSteppedControlEnabled: true })],
      nowMs: 1_100,
    });

    expect(reportedStore.get('dev-1')).toBeUndefined();
  });
});
