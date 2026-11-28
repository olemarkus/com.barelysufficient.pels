import type { MeterSilenceMonitorDeps } from '../../lib/power/meterSilence';

/**
 * A meter-silence monitor's limit reads for a test: Capacity limit on while
 * `capacityOn()` says so, every other limit off.
 */
export const meterSilenceLimitReads = (
  capacityOn: () => boolean,
): Pick<MeterSilenceMonitorDeps, 'getCapacitySettings' | 'getMainFuse' | 'getDailyBudgetSnapshot'> => ({
  getCapacitySettings: () => ({
    limitKw: 10, marginKw: 0.2, periodMinutes: 60, capacityEnabled: capacityOn(), gridImportLimitKw: null,
  }),
  getMainFuse: () => ({ kind: 'off' }),
  getDailyBudgetSnapshot: () => null,
});
