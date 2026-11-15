import { homeScopedSettingsKey, CAPACITY_FOLLOW_MONTH_PEAK } from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  assertCapacityFollowMonthPeakWrite,
  resolveCapacityFollowMonthPeakSetting,
} from '../../../shared-domain/src/settings/capacityFollowMonthPeak.ts';
import { FOLLOW_MONTH_PEAK_SAVE_FAILED_TOAST, FOLLOW_MONTH_PEAK_SAVED_TOAST } from './homeLimitsCopy.ts';
import { beginAreaWrite } from './homeLimitsWriteQueues.ts';
import { setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';

// A meter area's month-peak switch (`capacity_follow_month_peak:<homeId>`), for
// the per-home Limits & safety editor (`homeLimits.ts`).

/** A never-written switch is off; any other value that is not a boolean says nothing (`null`). */
export const readAreaFollowMonthPeak = (raw: unknown): boolean | null => {
  if (raw === null || raw === undefined) return false;
  const read = resolveCapacityFollowMonthPeakSetting(raw);
  return read.state === 'resolved' ? read.value : null;
};

/**
 * One open area editor's month-peak switch: what it shows, what was last read
 * or saved, and whether a write is in flight. Writes are serialised like the
 * area's control toggle: disabled while one is in flight, rolled back to the
 * stored value when it fails.
 */
export class AreaFollowMonthPeakSwitch {
  private persisted: boolean;

  private inFlight = false;

  constructor(readonly homeId: string, private shownValue: boolean) {
    this.persisted = shownValue;
  }

  get shown(): boolean { return this.shownValue; }

  get busy(): boolean { return this.inFlight; }

  /** A fresh read of the stored switch; a write in flight keeps what it shows. */
  applyRead(value: boolean | null): void {
    if (this.inFlight || value === null) return;
    this.shownValue = value;
    this.persisted = value;
  }

  /** `render` repaints the editor; `finishWrite` ends the area write this opened with `beginAreaWrite`. */
  async save(next: boolean, render: () => void, finishWrite: (homeId: string) => void): Promise<void> {
    if (this.inFlight) return;
    this.shownValue = next;
    if (this.persisted === next) {
      render();
      return;
    }
    this.inFlight = true;
    beginAreaWrite(this.homeId);
    render();
    try {
      assertCapacityFollowMonthPeakWrite(next);
      await setSetting(homeScopedSettingsKey(CAPACITY_FOLLOW_MONTH_PEAK, this.homeId), next);
      this.persisted = next;
    } catch (caught) {
      this.shownValue = this.persisted;
      this.settle(render, finishWrite);
      await logSettingsError('Failed to save meter-area month peak setting', caught, 'homeLimits');
      await showToastError(caught, FOLLOW_MONTH_PEAK_SAVE_FAILED_TOAST);
      return;
    }
    this.settle(render, finishWrite);
    await showToast(FOLLOW_MONTH_PEAK_SAVED_TOAST, 'ok');
  }

  private settle(render: () => void, finishWrite: (homeId: string) => void): void {
    this.inFlight = false;
    render();
    finishWrite(this.homeId);
  }
}
