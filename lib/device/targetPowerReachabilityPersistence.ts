import type { TargetPowerReachabilityState } from '../../packages/contracts/src/types';
import type { TimerRegistry } from '../utils/timerRegistry';

export type TargetPowerReachabilityPersistenceResult = 'persisted' | 'unchanged' | 'unavailable';
export type TargetPowerReachabilityApplyResult = {
  applied: boolean;
  persistence: TargetPowerReachabilityPersistenceResult | 'invalid';
};

const PERSISTENCE_RETRY_MS = 60 * 1000;

/** Keeps adopted reachability evidence pending until its persistence succeeds. */
export function createTargetPowerReachabilityPersistence(
  timers: TimerRegistry,
  write: (deviceId: string, state: TargetPowerReachabilityState) => TargetPowerReachabilityApplyResult,
  onApplied: (deviceId: string) => void,
): (deviceId: string, state: TargetPowerReachabilityState) => boolean {
  const pendingPersistenceByDevice = new Map<string, TargetPowerReachabilityState>();
  let persistenceTimer: ReturnType<typeof setTimeout> | undefined;

  const schedulePersistenceRetry = (): void => {
    if (persistenceTimer || pendingPersistenceByDevice.size === 0) return;
    const timer = setTimeout(() => {
      if (persistenceTimer !== timer) return;
      timers.clear('targetPowerReachabilityPersistence');
      persistenceTimer = undefined;
      for (const [deviceId, reachability] of pendingPersistenceByDevice) {
        const result = write(deviceId, reachability);
        if (result.persistence !== 'unavailable') {
          pendingPersistenceByDevice.delete(deviceId);
        }
      }
      schedulePersistenceRetry();
    }, PERSISTENCE_RETRY_MS);
    persistenceTimer = timers.registerTimeout('targetPowerReachabilityPersistence', timer);
  };

  const updateTargetPowerReachability = (
    deviceId: string,
    state: TargetPowerReachabilityState,
  ): boolean => {
    const result = write(deviceId, state);
    if (result.persistence === 'unavailable') {
      pendingPersistenceByDevice.set(deviceId, state);
      schedulePersistenceRetry();
    } else {
      pendingPersistenceByDevice.delete(deviceId);
    }
    if (result.applied) onApplied(deviceId);
    return result.applied;
  };

  return updateTargetPowerReachability;
}
