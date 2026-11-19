/**
 * Which recorded batteries a complete device refresh has missed often enough
 * that their claim record can be pruned. An empty refresh proves nothing about any one battery and
 * counts for nothing; a failed one never reaches here. A battery seen again
 * starts over.
 */
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';
import { getLogger } from '../logging/logger';

/** Consecutive complete device refreshes a battery must be missing from before its record is pruned. */
const PRUNE_AFTER_ABSENT_REFRESHES = 2;
const logger = getLogger('battery');

export class AbsentBatteries {
  /** Complete refreshes in a row each recorded battery has been missing from. */
  private readonly counts = new Map<string, number>();

  /** Count this refresh and request pruning for batteries missing long enough. */
  onSnapshot(
    recorded: Iterable<string>, refresh: ObservedDeviceStateRefreshPayload, prune: (deviceId: string) => boolean,
  ): void {
    if (refresh.entries.length === 0) return;
    const present = new Set(refresh.entries.map((entry) => entry.observed.id));
    for (const deviceId of recorded) {
      if (present.has(deviceId)) {
        this.counts.delete(deviceId);
        continue;
      }
      const absent = (this.counts.get(deviceId) ?? 0) + 1;
      this.counts.set(deviceId, absent);
      if (absent >= PRUNE_AFTER_ABSENT_REFRESHES && prune(deviceId)) {
        logger.info({ event: 'battery_control_claim_pruned', deviceId, reason: 'device_removed' });
      }
    }
  }

  forget(deviceId: string): void {
    this.counts.delete(deviceId);
  }
}
