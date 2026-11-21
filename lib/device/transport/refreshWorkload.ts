import { incPerfCounter, incPerfCounters } from '../../utils/perfCounters';

/**
 * Perf counters that size the device refresh workload: who starts a refresh,
 * and how many devices each kind of read returns. Read them from the
 * `perf_counters` line next to the app's memory figures.
 */
export type RefreshCaller =
  | 'snapshot_cycle'
  | 'device_poll'
  | 'post_actuation'
  | 'stuck_confirmation'
  | 'inventory'
  | 'temperature_recovery';

export const countRefreshCaller = (caller: RefreshCaller): void => {
  incPerfCounter(`device_refresh.${caller}_total`);
};

export const countRefreshRead = (targeted: boolean, deviceCount: number): void => {
  const kind = targeted ? 'targeted' : 'full';
  incPerfCounters([`device_refresh_read.${kind}_total`, [`device_refresh_read.${kind}_devices_total`, deviceCount]]);
};
