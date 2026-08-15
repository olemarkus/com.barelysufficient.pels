import { vi } from 'vitest';
import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDriftAgainstIntent,
} from '../../lib/executor/executorConvergence';
import { buildPlanMeta } from './planTestUtils';

/**
 * Default-stubbed shape of `PlanEngine` for tests. PlanService calls these
 * methods unconditionally on the live engine; every test that instantiates
 * PlanService must provide a mock that satisfies the full contract, not a
 * partial bag that a defensive `?.()` would tolerate.
 *
 * Tests spread overrides on top: `{ ...createMockPlanEngine(), buildDevicePlanSnapshot: ... }`.
 */
export const createMockPlanEngine = () => ({
  state: createPlanEngineState(),
  buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
    meta: buildPlanMeta({
      totalKw: null,
      softLimitKw: 0,
      headroomKw: 0}),
    devices: [],
  } satisfies DevicePlan),
  computeDynamicSoftLimit: vi.fn(() => 0),
  computeShortfallThreshold: vi.fn(() => 0),
  handleShortfall: vi.fn().mockResolvedValue(undefined),
  handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
  applyPlanActions: vi.fn().mockResolvedValue({ deviceWriteCount: 0, commandRequestCount: 0, appliedActions: false }),
  applySheddingToDevice: vi.fn().mockResolvedValue(undefined),
  hasPendingTargetCommands: vi.fn(() => false),
  hasPendingTargetCommandsOlderThan: vi.fn(() => false),
  hasPendingBinaryCommands: vi.fn(() => false),
  getPendingBinaryCommandForDevice: vi.fn(() => null),
  syncPendingTargetCommands: vi.fn(() => false),
  syncPendingBinaryCommands: vi.fn(() => false),
  prunePendingTargetCommands: vi.fn(() => false),
  shouldApplyStablePlanActions: vi.fn(() => false),
  // These two delegate to the REAL predicates rather than returning a canned
  // value. Before they were surfaced on PlanEngine, PlanService imported the
  // pure functions directly, so every existing spec exercised the real
  // convergence logic — a `vi.fn(() => false)` default here would silently
  // switch those specs to a no-op reconcile/refresh and hide regressions. The
  // functions are pure (no I/O, no clock), so calling them from a mock is safe.
  hasSettledActuation: vi.fn(
    (basePlan: DevicePlan, livePlan: DevicePlan) => canRefreshPlanSnapshotFromLiveState(basePlan, livePlan),
  ),
  hasExecutionWorkOutstanding: vi.fn(
    (plannedSnapshot: DevicePlan, liveDevices: PlanInputDevice[]) => (
      hasPlanExecutionDriftAgainstIntent(plannedSnapshot, liveDevices)
    ),
  ),
  decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
  evaluateHeadroomForDevice: vi.fn(() => null),
  syncHeadroomCardState: vi.fn(() => false),
  syncHeadroomUsageObservation: vi.fn(() => false),
  beginStartupRestoreStabilization: vi.fn(),
  clearStartupRestoreStabilization: vi.fn(() => false),
});
