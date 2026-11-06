import type { ObjectiveDeviceInput } from '../types';

// Retain the existing one-hour policy for accepted roster absence. An unavailable
// inventory entry still has to pass objective admission; transport owns failed reads.
export const ELIGIBILITY_ABANDON_GRACE_MS = 60 * 60 * 1000;

/** A captured eligibility read; it cannot advance grace or observe a preview candidate. */
export type TaskAllocationRosterSnapshot = {
  readonly shouldReserveMissingDevice: (deviceId: string, hasPersistedCommitment: boolean) => boolean;
};

/** Presence after the transport boundary's accepted snapshot and objective admission. */
export class TaskAllocationRoster {
  private readonly restartGraceEndsAtMs: number;
  private readonly lastSeenAtMsByDeviceId = new Map<string, number>();

  private readonly missingReservationSinceByDeviceId = new Map<string, number>();

  constructor(getNow: () => Date) {
    // One conservative restart allowance for persisted commitments, independent
    // of when or how often a preview is opened.
    this.restartGraceEndsAtMs = getNow().getTime() + ELIGIBILITY_ABANDON_GRACE_MS;
  }

  public observe(
    devices: readonly ObjectiveDeviceInput[],
    nowMs: number,
    /**
     * Durably out of the main planning lane (separately-metered home, or not
     * managed by PELS). Such a device is purged from the roster outright rather
     * than aged through the missing-device grace: the grace exists for a device
     * that should be here and briefly is not, and neither exclusion is that.
     */
    isDeviceExcluded: (deviceId: string) => boolean,
  ): void {
    for (const deviceId of this.missingReservationSinceByDeviceId.keys()) {
      if (isDeviceExcluded(deviceId)) this.missingReservationSinceByDeviceId.delete(deviceId);
    }
    const observedDeviceIds = new Set<string>();
    for (const device of devices) {
      if (isDeviceExcluded(device.id)) {
        this.lastSeenAtMsByDeviceId.delete(device.id);
        this.missingReservationSinceByDeviceId.delete(device.id);
        continue;
      }
      observedDeviceIds.add(device.id);
      this.lastSeenAtMsByDeviceId.set(device.id, nowMs);
      this.missingReservationSinceByDeviceId.delete(device.id);
    }
    for (const [deviceId, lastSeenAtMs] of this.lastSeenAtMsByDeviceId) {
      if (isDeviceExcluded(deviceId)) {
        this.lastSeenAtMsByDeviceId.delete(deviceId);
        this.missingReservationSinceByDeviceId.delete(deviceId);
        continue;
      }
      if (observedDeviceIds.has(deviceId)) continue;
      if (!this.missingReservationSinceByDeviceId.has(deviceId)) {
        this.missingReservationSinceByDeviceId.set(deviceId, lastSeenAtMs);
      }
      if (nowMs - lastSeenAtMs >= ELIGIBILITY_ABANDON_GRACE_MS) {
        this.lastSeenAtMsByDeviceId.delete(deviceId);
      }
    }
  }

  public retainObjectiveDeviceIds(deviceIds: ReadonlySet<string>): void {
    for (const deviceId of this.lastSeenAtMsByDeviceId.keys()) {
      if (!deviceIds.has(deviceId)) this.lastSeenAtMsByDeviceId.delete(deviceId);
    }
    for (const deviceId of this.missingReservationSinceByDeviceId.keys()) {
      if (!deviceIds.has(deviceId)) this.missingReservationSinceByDeviceId.delete(deviceId);
    }
  }

  public read(nowMs: number): TaskAllocationRosterSnapshot {
    // A preview can see a disappearance before the next live update. The last
    // accepted presence is already its grace baseline; reading never starts one.
    const missingSinceById = new Map([
      ...this.lastSeenAtMsByDeviceId,
      ...this.missingReservationSinceByDeviceId,
    ]);
    const inRestartGrace = nowMs < this.restartGraceEndsAtMs;
    return {
      shouldReserveMissingDevice: (deviceId, hasPersistedCommitment) => {
        const missingSinceMs = missingSinceById.get(deviceId);
        return missingSinceMs === undefined
          ? hasPersistedCommitment && inRestartGrace
          : nowMs - missingSinceMs < ELIGIBILITY_ABANDON_GRACE_MS;
      },
    };
  }
}
