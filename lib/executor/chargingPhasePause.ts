import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type { ControlContestRecording } from '../ports/controlContest';
import type { ChargingPhasePauseLifecycle, ChargingPhasePauseRecording } from '../ports/chargingPhases';
import { isHomeyRequestTimeout } from '../utils/errorUtils';
import type { HomeId } from '../utils/settingsKeys';

/** The current owning home's binary attribution, resolved immediately before the pause. */
export type ChargingPhasePauseTarget = {
  homeId: HomeId;
  pendingCommands: PendingBinaryCommandStore;
};

/** A phase hand-back pause follows the same observer lifecycle as other planned binary writes. */
export class ChargingPhasePauseRecorder implements ChargingPhasePauseRecording {
  constructor(
    private readonly contests: ControlContestRecording,
    private readonly resolveTarget: (deviceId: string) => ChargingPhasePauseTarget,
  ) {}

  forDevice(deviceId: string): ChargingPhasePauseLifecycle {
    let target: ChargingPhasePauseTarget | undefined;
    let startedAtMs: number | undefined;
    let preservesExistingOff = false;
    const accepted = () => {
      if (!target || startedAtMs === undefined) throw new Error('Charging pause was not started.');
      if (!preservesExistingOff) {
        target.pendingCommands.recordDispatchAccepted(deviceId, { deviceId, desired: false, startedAtMs });
      }
      this.contests.commandSent({ homeId: target.homeId, deviceId, deviceName: deviceId,
        setting: 'on_off', value: false, atMs: startedAtMs });
    };
    return {
      onStarting: (atMs) => {
        target = this.resolveTarget(deviceId);
        startedAtMs = atMs;
        // An existing capacity off must retain its capacity-pressure provenance.
        preservesExistingOff = target.pendingCommands.hasActiveTurnOff(deviceId);
        if (!preservesExistingOff) {
          target.pendingCommands.record(deviceId, { desired: false, startedMs: atMs, lifecycleRelease: true });
        }
      },
      onAccepted: accepted,
      onFailed: (error) => {
        if (!target || startedAtMs === undefined) throw new Error('Charging pause was not started.');
        if (isHomeyRequestTimeout(error)) { accepted(); return; }
        if (preservesExistingOff) return;
        target.pendingCommands.recordDispatchFailed(deviceId, { deviceId, desired: false, startedAtMs });
        if (target.pendingCommands.peek(deviceId)?.startedMs === startedAtMs) target.pendingCommands.clear(deviceId);
      },
    };
  }
}
