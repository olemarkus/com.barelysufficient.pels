import { describe, expect, it } from 'vitest';
import { syncSteppedCommands } from '../../lib/executor/syncSteppedCommands';
import type { SteppedSettleDevice } from '../../lib/observer/steppedSettleSnapshot';
import { STEPPED_LOAD_COMMAND_STALE_MS } from '../../lib/executor/steppedCommandState';
import { steppedStoresForTest } from '../helpers/steppedStores';

const device = (overrides: Partial<SteppedSettleDevice> = {}): SteppedSettleDevice => ({
  id: 'dev-1',
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
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    const changed = syncSteppedCommands({
      store,
      devices: [device({
        steppedCommandConfirmation: { state: 'observed', observedStepId: 'high', observedAtMs: 1_500 },
      })],
      nowMs: 1_500,
    });

    expect(changed).toBe(true);
    expect(store.getDesired('dev-1')).toMatchObject({ status: 'success' });
  });

  it('concludes nothing when the device has said nothing about a rung', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    syncSteppedCommands({ store, devices: [device()], nowMs: 1_500 });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'pending' });
  });

  it('does not confirm a command against a different rung than the one asked for', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    syncSteppedCommands({
      store,
      devices: [device({
        steppedCommandConfirmation: { state: 'observed', observedStepId: 'low', observedAtMs: 1_500 },
      })],
      nowMs: 1_500,
    });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'pending' });
  });

  it('lapses an unanswered command once its pending window has passed', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    syncSteppedCommands({
      store,
      devices: [device()],
      nowMs: 1_000 + STEPPED_LOAD_COMMAND_STALE_MS,
    });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'stale' });
  });

  it('ends the command session when the on-session ends', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    // The edge needs both samples: the pass that sees ON, then the one that
    // sees OFF. A single OFF sample concludes nothing about a session it never
    // saw running.
    syncSteppedCommands({ store, devices: [device({ observedOn: true })], nowMs: 1_100 });
    syncSteppedCommands({ store, devices: [device({ observedOn: false })], nowMs: 1_200 });

    expect(store.getDesired('dev-1')).toBeUndefined();
    expect(store.hasPriorStepCommand('dev-1')).toBe(false);
  });

  it('is reached when a stepped command is the ONLY thing in flight', () => {
    // The plan service guards the target/binary sweeps on their own pending
    // predicates, and neither speaks for this axis. Running the stepped sweep
    // after that guard left a native rung or an on→off observation unsettled
    // until some later meter-driven rebuild — on an irregular Flow feed, long
    // enough to suppress retries for a device that had already reported.
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });
    expect(store.hasTrackedState()).toBe(true);

    const changed = syncSteppedCommands({
      store,
      devices: [device({
        steppedCommandConfirmation: { state: 'observed', observedStepId: 'high', observedAtMs: 1_500 },
      })],
      nowMs: 1_500,
    });

    expect(changed).toBe(true);
    expect(store.isStepCommandPending('dev-1')).toBe(false);
  });

  it('counts no command for a step once the device reports another level after one of them', () => {
    // Asked for `high`, the device clamps at `medium` and says so. Its report
    // came back, so neither this command nor a reissue that changes nothing
    // (and so draws no new report) is one nothing answered.
    const { store } = steppedStoresForTest();
    const clamped = device({
      steppedCommandConfirmation: { state: 'observed', observedStepId: 'medium', observedAtMs: 1_500 },
    });
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });
    syncSteppedCommands({ store, devices: [clamped], nowMs: 1_000 + STEPPED_LOAD_COMMAND_STALE_MS });
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 200_000 });
    syncSteppedCommands({ store, devices: [clamped], nowMs: 200_000 + STEPPED_LOAD_COMMAND_STALE_MS });

    expect(store.getDesired('dev-1')).toMatchObject({ stepId: 'high', status: 'stale' });
    expect(store.getUnansweredStepCommands('dev-1')).toEqual({ kind: 'none' });
  });

  it('counts a command a report from before it does not answer', () => {
    const { store } = steppedStoresForTest();
    const reportedEarlier = device({
      steppedCommandConfirmation: { state: 'observed', observedStepId: 'medium', observedAtMs: 500 },
    });
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });
    syncSteppedCommands({ store, devices: [reportedEarlier], nowMs: 1_000 + STEPPED_LOAD_COMMAND_STALE_MS });
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 200_000 });
    syncSteppedCommands({ store, devices: [reportedEarlier], nowMs: 200_000 + STEPPED_LOAD_COMMAND_STALE_MS });

    expect(store.getUnansweredStepCommands('dev-1')).toEqual({ kind: 'unanswered', stepId: 'high', count: 2 });
  });

  it('reports nothing tracked on a fresh store, so the sweep can be skipped', () => {
    const { store } = steppedStoresForTest();
    expect(store.hasTrackedState()).toBe(false);
  });

});
