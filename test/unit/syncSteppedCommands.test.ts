import { describe, expect, it } from 'vitest';
import { syncSteppedCommands } from '../../lib/executor/syncSteppedCommands';
import type { SteppedSettleDevice } from '../../lib/observer/steppedSettleSnapshot';
import { STEPPED_LOAD_COMMAND_STALE_MS } from '../../lib/executor/steppedCommandState';
import { resolveSteppedCommandAttempt } from '../../lib/executor/steppedCommandAttempt';
import { STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS } from '../../lib/executor/commandRetrySchedule';
import { ACKNOWLEDGED_COMMAND_SETTLE_MS } from '../../lib/ports/controlCommandConfirmation';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { steppedStoresForTest } from '../helpers/steppedStores';
import { buildSteppedSettleSnapshot } from '../../lib/observer/steppedSettleSnapshot';

const device = (overrides: Partial<SteppedSettleDevice> = {}): SteppedSettleDevice => ({
  id: 'dev-1',
  lowestActiveStepId: 'low',
  observedOn: true,
  steppedCommandConfirmation: { state: 'unavailable' },
  steppedCommandAcknowledgement: { state: 'unavailable' },
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

const ladder: SteppedLoadProfile = {
  steps: [{ id: 'off', planningPowerW: 0 }, { id: '20a', planningPowerW: 13_800 }, { id: '24a', planningPowerW: 16_560 }],
};

/**
 * A device that echoes its accepted setting (a cloud car publishing its new
 * charge limit) answers a command long before its draw report does. The echo
 * stops the resend; only the settled report confirms.
 */
describe('syncSteppedCommands: acknowledged commands', () => {
  const ISSUED = 1_000_000;
  const acknowledging = (stepId: string, observedAtMs: number, overrides: Partial<SteppedSettleDevice> = {}) => device({
    steppedCommandAcknowledgement: { state: 'observed', acknowledgedStepId: stepId, observedAtMs },
    steppedCommandConfirmation: { state: 'observed', observedStepId: '24a', observedAtMs: ISSUED - 60_000 },
    ...overrides,
  });
  const attemptAt = (store: ReturnType<typeof steppedStoresForTest>['store'], nowMs: number) => (
    resolveSteppedCommandAttempt(store.getDesired('dev-1'), ladder, '20a', nowMs)
  );

  it('acknowledges, but does not confirm, a command its setting echo names after it was issued', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', issuedAtMs: ISSUED });

    syncSteppedCommands({ store, devices: [acknowledging('20a', ISSUED + 5_000)], nowMs: ISSUED + 5_000 });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'acknowledged', acknowledgedAtMs: ISSUED + 5_000 });
    expect(store.isStepCommandPending('dev-1')).toBe(true);
  });

  it('ignores an echo from before the command was issued', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', issuedAtMs: ISSUED });

    syncSteppedCommands({ store, devices: [acknowledging('20a', ISSUED - 1)], nowMs: ISSUED + 5_000 });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'pending' });
  });

  it('is not re-sent inside the acknowledgement window, and confirms on the settled report', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', issuedAtMs: ISSUED });
    const echoed = acknowledging('20a', ISSUED + 5_000);

    // Every pass the unconfirmed command used to go stale at 90 s and resend on
    // the 30 s / 2 / 5 / 15 min ladder.
    for (const nowMs of [ISSUED + 5_000, ISSUED + 95_000, ISSUED + 10 * 60_000, ISSUED + 19 * 60_000]) {
      syncSteppedCommands({ store, devices: [echoed], nowMs });
      expect(store.getDesired('dev-1')?.status).toBe('acknowledged');
      expect(attemptAt(store, nowMs)).toEqual({ status: 'awaiting_confirmation', requestedStepId: '20a' });
    }

    syncSteppedCommands({
      store,
      devices: [acknowledging('20a', ISSUED + 5_000, {
        steppedCommandConfirmation: { state: 'observed', observedStepId: '20a', observedAtMs: ISSUED + 15 * 60_000 },
      })],
      nowMs: ISSUED + 19 * 60_000 + 1,
    });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'success' });
    expect(store.isStepCommandPending('dev-1')).toBe(false);
  });

  it('turns stale on the ordinary backoff when the window expires unsettled, and the same echo cannot revive it', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', issuedAtMs: ISSUED });
    const echoed = acknowledging('20a', ISSUED + 5_000);
    syncSteppedCommands({ store, devices: [echoed], nowMs: ISSUED + 5_000 });

    const expiredAtMs = ISSUED + ACKNOWLEDGED_COMMAND_SETTLE_MS;
    syncSteppedCommands({ store, devices: [echoed], nowMs: expiredAtMs });

    const retryAtMs = expiredAtMs + STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS[0];
    expect(store.getDesired('dev-1')).toMatchObject({ status: 'stale', nextRetryAtMs: retryAtMs });
    expect(store.isStepCommandPending('dev-1')).toBe(false);
    expect(attemptAt(store, expiredAtMs)).toEqual({ status: 'retry_backoff', requestedStepId: '20a' });
    expect(attemptAt(store, retryAtMs)).toBeNull();
  });

  it('becomes eligible for retry when a newer report contradicts the acknowledgement', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', issuedAtMs: ISSUED });
    syncSteppedCommands({ store, devices: [acknowledging('20a', ISSUED + 5_000)], nowMs: ISSUED + 5_000 });

    // The car's poll put the limit back where it was.
    const revertedAtMs = ISSUED + 6 * 60_000;
    syncSteppedCommands({ store, devices: [acknowledging('24a', revertedAtMs)], nowMs: revertedAtMs });

    const retryAtMs = revertedAtMs + STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS[0];
    expect(store.getDesired('dev-1')).toMatchObject({ status: 'stale', nextRetryAtMs: retryAtMs });
    expect(attemptAt(store, retryAtMs)).toBeNull();
  });

  it('becomes eligible for retry when a newer settled report names another step', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', issuedAtMs: ISSUED });
    syncSteppedCommands({ store, devices: [acknowledging('20a', ISSUED + 5_000)], nowMs: ISSUED + 5_000 });

    syncSteppedCommands({
      store,
      devices: [acknowledging('20a', ISSUED + 5_000, {
        steppedCommandConfirmation: { state: 'observed', observedStepId: '24a', observedAtMs: ISSUED + 60_000 },
      })],
      nowMs: ISSUED + 60_000,
    });

    expect(store.getDesired('dev-1')).toMatchObject({ status: 'stale' });
  });

  it('sends a 24 A to 20 A command once when the echo is immediate and the draw report comes 15 minutes later', () => {
    // The reported case: the same command was re-sent four times in 13 minutes.
    const { store } = steppedStoresForTest();
    const source = {
      id: 'dev-1', binaryControl: { on: true }, steppedLoadProfile: ladder, selectedStepId: '24a',
      reportedStepId: '24a', reportedStepObservedAtMs: ISSUED - 60_000,
    };
    let sends = 0;
    let echo: { stepId: string; observedAtMs: number } | undefined;
    let report = { reportedStepId: '24a', reportedStepObservedAtMs: ISSUED - 60_000 };
    for (let nowMs = ISSUED; nowMs <= ISSUED + 16 * 60_000; nowMs += 30_000) {
      if (nowMs === ISSUED + 30_000) echo = { stepId: '20a', observedAtMs: ISSUED + 5_000 };
      if (nowMs === ISSUED + 15 * 60_000) report = { reportedStepId: '20a', reportedStepObservedAtMs: nowMs };
      const settleDevices = buildSteppedSettleSnapshot([{
        ...source, ...report, ...(echo ? { acknowledgedStep: echo } : {}),
      }]);
      syncSteppedCommands({ store, devices: settleDevices, nowMs });
      const desired = store.getDesired('dev-1');
      if (desired?.status !== 'success' && attemptAt(store, nowMs) === null) {
        store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', previousStepId: '24a', issuedAtMs: nowMs });
        sends += 1;
      }
    }

    expect(sends).toBe(1);
    expect(store.getDesired('dev-1')).toMatchObject({ status: 'success', retryCount: 0 });
  });

  it('keeps the unacknowledged path unchanged: stale at the 90 s window, then the first retry rung', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: '20a', issuedAtMs: ISSUED });

    syncSteppedCommands({ store, devices: [device()], nowMs: ISSUED + STEPPED_LOAD_COMMAND_STALE_MS - 1 });
    expect(attemptAt(store, ISSUED + STEPPED_LOAD_COMMAND_STALE_MS - 1))
      .toEqual({ status: 'awaiting_confirmation', requestedStepId: '20a' });

    syncSteppedCommands({ store, devices: [device()], nowMs: ISSUED + STEPPED_LOAD_COMMAND_STALE_MS });
    const retryAtMs = ISSUED + STEPPED_LOAD_COMMAND_STALE_MS + STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS[0];
    expect(store.getDesired('dev-1')).toMatchObject({ status: 'stale', nextRetryAtMs: retryAtMs });
    expect(attemptAt(store, retryAtMs)).toBeNull();
  });
});
