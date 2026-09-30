/**
 * The stepped axis's settle sweep — the twin of `syncPendingBinaryCommands`
 * (`lib/observer/pendingBinaryCommands.ts`), and called from the same two places.
 *
 * WHY THIS EXISTS: a stepped command used to settle inside
 * `decorateSnapshotWithDeviceControl`, the plan-input producer. Three things
 * were wrong with that. A command confirmed because the PLANNER asked for its
 * devices rather than because the executor observed the command materialize, so
 * settle timing rode on plan-build cadence. Reading the plan input had side
 * effects, which is why `getPlanInputSnapshot` — a getter that decorates on
 * every access — could not be used by anything that needed a pure read;
 * `setup/appInit/wireHomeMembership.ts` and `createGenerationPollSource.ts` both
 * route around it in so many words. And it carried the commanded axis to the
 * planner with no import edge for `no-plan-to-executor` to object to.
 *
 * The device owner resolves the ladder and admits the reported rung before
 * Observer projects confirmation evidence. This sweep consumes that evidence
 * without selecting a profile or validating the report again.
 */
import type { SteppedCommandStore } from './steppedCommandStore';
import type { SteppedSettleDevice } from '../observer/steppedSettleSnapshot';


export type SyncSteppedCommandsParams = {
  store: SteppedCommandStore;
  devices: readonly SteppedSettleDevice[];
  nowMs?: number;
};

/**
 * Advance every tracked stepped command against what the devices now say.
 *
 * Ordering matters and is the decorator's, preserved: expire the ended
 * on-session first (a device that went off has no live command to confirm),
 * then confirm against the reported rung, then reconcile the initialization
 * latch against the ladder in force. The stale sweep runs once for the whole
 * pass rather than per device, because it is a timeout over the whole store.
 *
 * Returns whether anything changed, so the caller can decide whether the plan
 * snapshot is worth refreshing — the same contract `syncPendingBinaryCommands`
 * offers.
 */
export const syncSteppedCommands = (params: SyncSteppedCommandsParams): boolean => {
  const {
    store, devices, nowMs = Date.now(),
  } = params;
  let changed = store.pruneStale(nowMs);

  for (const device of devices) {
    const before = store.getDesired(device.id);
    store.expireConfirmedDesiredOnBinaryOff(device.id, device.observedOn);

    const confirmation = device.steppedCommandConfirmation;
    if (confirmation.state === 'observed') {
      const desired = store.getDesired(device.id);
      if (desired?.stepId === confirmation.observedStepId) {
        store.confirmDesired(device.id, desired);
      }
    }

    store.reconcileInitializationLatch(device.id, device.lowestActiveStepId);
    if (!changed && store.getDesired(device.id) !== before) changed = true;
  }

  return changed;
};
