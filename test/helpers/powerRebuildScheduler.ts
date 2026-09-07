import { vi, type MockInstance } from 'vitest';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { RebuildOutcome } from '../../lib/plan/rebuildScheduler/policy';
import type {
  HardCapBreach,
  PlanRebuildPosture,
  PowerRebuildSignal,
  RebuildCadence,
} from '../../lib/plan/rebuildScheduler/rebuildSignal';
import { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import {
  initialPlanRebuildThrottleMemory,
  PlanRebuildThrottle,
  type PlanRebuildThrottleMemory,
} from '../../lib/plan/rebuildScheduler/throttle';
import { createTestCapacityGuard } from './createTestCapacityGuard';

/** A throttle memory at rest, with the fields under test overridden. */
export const throttleMemoryFixture = (
  overrides: Partial<PlanRebuildThrottleMemory> = {},
): PlanRebuildThrottleMemory => ({ ...initialPlanRebuildThrottleMemory(), ...overrides });

/**
 * A throttle and the scheduler it queues into, wired as production wires them
 * (`setup/planRebuildIntentPolicy.ts` for main, `createBundleRebuildRuntime`
 * for a sub-home): due times and execution come back to the throttle, a
 * cancelled intent releases the rebuild queued for it. Specs drive the throttle
 * and read its `snapshot()`; nothing here is a second code path.
 *
 * `checkShortfall` is a pass-through spy on the guard, so a spec can assert
 * the deficit a tight no-op reported without stubbing the guard away.
 */
export const createTestPlanRebuildThrottle = (params: {
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
  cadence: RebuildCadence;
  memory?: PlanRebuildThrottleMemory;
  getNowMs?: () => number;
  logError?: (error: Error) => void;
  capacityGuard?: CapacityGuard;
}): { throttle: PlanRebuildThrottle; scheduler: PlanRebuildScheduler; checkShortfall: MockInstance } => {
  const getNowMs = params.getNowMs ?? Date.now;
  const guard = params.capacityGuard ?? createTestCapacityGuard({ homeId: 'main' });
  const checkShortfall = vi.spyOn(guard, 'checkShortfall');
  const throttle: PlanRebuildThrottle = new PlanRebuildThrottle(
    {
      getScheduler: () => scheduler,
      getCapacityGuard: () => guard,
      getNowMs,
      rebuildPlanFromCache: params.rebuildPlanFromCache,
    },
    params.cadence,
    params.memory ?? initialPlanRebuildThrottleMemory(),
  );
  const scheduler: PlanRebuildScheduler = new PlanRebuildScheduler({
    getNowMs,
    resolveDueAtMs: (intent, state) => throttle.dueAtMs(intent, state.nowMs),
    executeIntent: (intent) => {
      if (intent.kind !== 'signal' && intent.kind !== 'hardCap') return undefined;
      return throttle.execute();
    },
    onIntentCancelled: (intent, reason) => {
      if (intent.kind === 'signal' || intent.kind === 'hardCap') throttle.cancel(reason);
    },
    onIntentError: (_intent, error) => {
      params.logError?.(error);
    },
  });
  return { throttle, scheduler, checkShortfall };
};

/**
 * Test-only adapter onto `PlanRebuildThrottle.onSignal`.
 *
 * Production resolves a complete `PowerRebuildSignal` at the seam — every field
 * present. Specs care about one or two fields at a time, so this fills the rest
 * with neutral values and keeps each case readable. It is a fixture builder, not
 * a second code path: the throttle under test is the real one.
 */
export const schedulePowerSampleForTest = (options: {
  throttle: PlanRebuildThrottle;
  limitKw: number;
  currentPowerW?: number;
  capacityPaceKw?: number;
  shortfallThresholdKw?: number;
  isInShortfall?: boolean;
  hardCapBreach?: HardCapBreach;
  planConvergenceActive?: boolean;
  unactionable?: boolean;
  shortfallUnrecoverable?: boolean;
}): Promise<void | string> => {
  const currentPowerW = options.currentPowerW ?? 0;
  const capacityPaceKw = options.capacityPaceKw ?? options.limitKw;
  const totalKw = currentPowerW / 1000;
  const signal: PowerRebuildSignal = {
    currentPowerW,
    totalKw,
    limitKw: options.limitKw,
    capacityPaceKw,
    // Always derived. An override let a spec state a headroom its own pace and
    // power could not produce, which is how five of them came to assert a cause
    // that never fired.
    headroomKw: capacityPaceKw - totalKw,
    shortfallThresholdKw: options.shortfallThresholdKw ?? options.limitKw,
    isInShortfall: options.isInShortfall ?? false,
    hardCapBreach: options.hardCapBreach ?? { breached: false, deficitKw: 0 },
    planConvergenceActive: options.planConvergenceActive ?? false,
    unactionable: options.unactionable ?? false,
  };
  const posture: PlanRebuildPosture = {
    planConvergenceActive: signal.planConvergenceActive,
    unactionable: signal.unactionable,
    shortfallUnrecoverable: options.shortfallUnrecoverable ?? false,
  };
  return options.throttle.onSignal(signal, posture);
};

/**
 * Test-only adapter onto `PlanRebuildThrottle.onSample`. Same rationale as
 * `schedulePowerSampleForTest`: the seam resolves a complete reading, specs
 * vary one field at a time. `totalKw` defaults to the sample's own watts
 * because that is what the tracker latches for it — a fixture convenience, not
 * a copy of production policy (the producer passes the latch and nothing else).
 */
export const scheduleSignalForTest = (options: {
  throttle: PlanRebuildThrottle;
  currentPowerW: number;
  totalKw?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  capacityPaceKw?: number;
  shortfallThresholdKw?: number;
  planConvergenceActive?: boolean;
  shortfallUnrecoverable?: boolean;
  unactionable?: boolean;
}): Promise<void | string> => options.throttle.onSample(
  {
    currentPowerW: options.currentPowerW,
    totalKw: options.totalKw ?? options.currentPowerW / 1000,
    limitKw: options.capacitySettings.limitKw,
    capacityPaceKw: options.capacityPaceKw ?? options.capacitySettings.limitKw,
    shortfallThresholdKw: options.shortfallThresholdKw ?? options.capacitySettings.limitKw,
  },
  {
    planConvergenceActive: options.planConvergenceActive ?? false,
    unactionable: options.unactionable ?? false,
    shortfallUnrecoverable: options.shortfallUnrecoverable ?? false,
  },
);

/**
 * Re-stamp when (and at what power) a live throttle last rebuilt, keeping the
 * rest of its memory. Specs use it to open or close the max-interval escape
 * and the min-interval hold without rebuilding the wiring around the throttle.
 */
export const rememberLastRebuild = (throttle: PlanRebuildThrottle, atMs: number, powerW?: number): void => {
  const current = throttle.snapshot().lastRebuild;
  throttle['restore']({
    ...throttle.snapshot(),
    lastRebuild: {
      atMs,
      powerW: powerW ?? current?.powerW ?? 0,
      hardCapBreach: current?.hardCapBreach ?? { breached: false, deficitKw: 0 },
    },
  });
};

/** A throttle for a context stub that never samples: inert scheduler, no-op rebuild. */
export const createInertPlanRebuildThrottle = (): PlanRebuildThrottle => createTestPlanRebuildThrottle({
  rebuildPlanFromCache: async () => undefined,
  cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 100 },
}).throttle;
