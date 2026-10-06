/**
 * Which recorded batteries a complete device refresh has missed often enough
 * that their claim record can be pruned. An empty refresh proves nothing
 * about any one battery and counts for nothing; a failed one never reaches
 * here. A battery seen again starts over.
 */
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';

/** Consecutive complete device refreshes a battery must be missing from before its record is pruned. */
const PRUNE_AFTER_ABSENT_REFRESHES = 2;

export class AbsentBatteries {
  /** Complete refreshes in a row each recorded battery has been missing from. */
  private readonly counts = new Map<string, number>();

  /** Count this refresh for every recorded battery, answering those now missing long enough to prune. */
  dueForPrune(recorded: Iterable<string>, refresh: ObservedDeviceStateRefreshPayload): string[] {
    if (refresh.entries.length === 0) return [];
    const present = new Set(refresh.entries.map((entry) => entry.observed.id));
    const due: string[] = [];
    for (const deviceId of recorded) {
      if (present.has(deviceId)) {
        this.counts.delete(deviceId);
        continue;
      }
      const absent = (this.counts.get(deviceId) ?? 0) + 1;
      this.counts.set(deviceId, absent);
      if (absent >= PRUNE_AFTER_ABSENT_REFRESHES) due.push(deviceId);
    }
    return due;
  }

  forget(deviceId: string): void {
    this.counts.delete(deviceId);
  }
}
