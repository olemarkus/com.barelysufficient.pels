import { vi } from 'vitest';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { createPlanEngineState } from '../../lib/plan/planState';

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
    meta: {
      totalKw: null,
      softLimitKw: 0,
      headroomKw: 0,
    },
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
  decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
  evaluateHeadroomForDevice: vi.fn(() => null),
  syncHeadroomCardState: vi.fn(() => false),
  syncHeadroomUsageObservation: vi.fn(() => false),
  beginStartupRestoreStabilization: vi.fn(),
  clearStartupRestoreStabilization: vi.fn(() => false),
});
