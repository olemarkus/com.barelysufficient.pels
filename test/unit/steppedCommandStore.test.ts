import { describe, expect, it } from 'vitest';
import { steppedStoresForTest } from '../helpers/steppedStores';
import { STEPPED_LOAD_COMMAND_STALE_MS } from '../../lib/executor/steppedCommandState';

/**
 * The store's own contract: it is the single path to the commanded axis. The
 * transitions themselves are covered against `steppedCommandState.ts`; what is
 * asserted here is that each question a consumer used to answer by reaching
 * into the raw maps is answered by a method, and answers the same thing.
 */
describe('SteppedCommandStore', () => {
  it('tracks an issued command as pending and hands it back', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    expect(store.getDesired('dev-1')).toMatchObject({
      stepId: 'high', pending: true, status: 'pending',
    });
    expect(store.hasPriorStepCommand('dev-1')).toBe(true);
    expect(store.getDesired('dev-2')).toBeUndefined();
    expect(store.hasPriorStepCommand('dev-2')).toBe(false);
  });

  it('goes stale only once the pending window has elapsed', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });

    expect(store.pruneStale(1_000 + STEPPED_LOAD_COMMAND_STALE_MS - 1)).toBe(false);
    expect(store.getDesired('dev-1')?.status).toBe('pending');

    expect(store.pruneStale(1_000 + STEPPED_LOAD_COMMAND_STALE_MS)).toBe(true);
    expect(store.getDesired('dev-1')).toMatchObject({ pending: false, status: 'stale' });
  });

  it('clears the whole command session when the ladder changed under it', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({
      deviceId: 'dev-1', desiredStepId: 'low', issuedAtMs: 1_000, confirmationPolicy: 'assume_applied',
    });
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 2_000 });
    expect(store.resolveInitializationLatch('dev-1', 'low')).toBe('low');

    store.clearCommandSession('dev-1');

    expect(store.resolveInitializationLatch('dev-1', 'low')).toBeUndefined();
    expect(store.getDesired('dev-1')).toBeUndefined();
    expect(store.hasPriorStepCommand('dev-1')).toBe(false);
  });

  it('reports a pending target-power probe only while one is in flight', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });
    // A command with no admitted rung above the confirmed ceiling is not a probe.
    expect(store.hasPendingTargetPowerProbe()).toBe(false);

    store.markDesiredStepIssued({
      deviceId: 'dev-2',
      desiredStepId: 'high',
      issuedAtMs: 1_000,
      planningPowerW: 7_000,
      targetPowerProbeConfirmedMaxPowerW: 3_600,
    });
    expect(store.hasPendingTargetPowerProbe()).toBe(true);

    // Settling the probe ends it: nothing is in flight to settle any more.
    store.deleteDesired('dev-2');
    expect(store.hasPendingTargetPowerProbe()).toBe(false);
  });

  it('drops a stale initialization latch when the ladder changed under it', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({
      deviceId: 'dev-1', desiredStepId: 'low', issuedAtMs: 1_000, confirmationPolicy: 'assume_applied',
    });
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 2_000 });

    // The ladder's lowest active rung is no longer the one the latch named.
    expect(store.resolveInitializationLatch('dev-1', 'lowest-2')).toBeUndefined();

    expect(store.getDesired('dev-1')).toBeUndefined();
    expect(store.hasPriorStepCommand('dev-1')).toBe(false);
  });

  it('drops a command session when the device is observed turning off', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'high', issuedAtMs: 1_000 });
    store.expireConfirmedDesiredOnBinaryOff('dev-1', true);
    expect(store.getDesired('dev-1')).toBeDefined();

    store.expireConfirmedDesiredOnBinaryOff('dev-1', false);

    expect(store.getDesired('dev-1')).toBeUndefined();
    expect(store.hasPriorStepCommand('dev-1')).toBe(false);
  });
});
