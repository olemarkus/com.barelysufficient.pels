import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import type { DailyBudgetService } from '../dailyBudget/dailyBudgetService';
import { buildPeriodicStatusLog } from '../core/periodicStatus';

export function logPeriodicStatus(params: {
  capacityGuard?: CapacityGuard;
  powerTracker: PowerTrackerState;
  capacitySettings: { limitKw: number; marginKw: number };
  operatingMode: string;
  capacityDryRun: boolean;
  dailyBudgetService: DailyBudgetService;
  log: (...args: unknown[]) => void;
}): void {
  const {
    capacityGuard,
    powerTracker,
    capacitySettings,
    operatingMode,
    capacityDryRun,
    dailyBudgetService,
    log,
  } = params;
  log(buildPeriodicStatusLog({
    capacityGuard,
    powerTracker,
    capacitySettings,
    operatingMode,
    capacityDryRun,
  }));
  const dailyBudgetLog = dailyBudgetService.getPeriodicStatusLog();
  if (dailyBudgetLog) {
    log(dailyBudgetLog);
  }
}
