/**
 * Specs that exercise drift supply the fixtures the observer would have served.
 * Absent, the engine sees no observations at all — which the predicate skips,
 * matching a device the observer has not yet seen.
 */
import { vi } from 'vitest';
import type { DevicePlan, PlanInputDevice, BinaryControlDiscriminantProbe } from '../../lib/plan/planTypes';
import { createPlanEngineState } from './planEngineStateFixture';
import { hasPlanExecutionDriftAgainstIntent } from '../../lib/executor/executorConvergence';
import { buildPlanMeta } from './planTestUtils';
import { driftDepsFromPlanInputs } from './driftObservationTestUtils';
import type { DriftCommandRead } from '../../lib/executor/driftObservedDevice';
import type { HeadroomForDeviceDecision } from '../../lib/plan/planHeadroomDevice';
import { executionStateFixture } from './deviceStatusFixture';
import { isMeteredPlanDevice } from '../../lib/plan/planMeteredDevice';

export type MockPlanEngineOptions = {
  getDriftDevices?: () => PlanInputDevice[];
  /**
   * The executor's in-flight BINARY command per device. Separate from
   * `getDriftDevices` because in-flight command state is not a property of the
   * observed device and no longer rides on the plan-input seam; the default is
   * "nothing in flight", which is what a spec that never issues a command
   * means.
   */
  getDriftBinaryCommand?: (deviceId: string) => DriftCommandRead['binary'];
  /**
   * Observer accepted-write counter. A spec that wants to model an observation
   * landing mid-build advances what this returns between the build and the
   * apply; the default is a constant, i.e. "the world held still".
   */
  getObservationRevision?: () => number;
};

/**
 * Default-stubbed shape of `PlanEngine` for tests. PlanService calls these
 * methods unconditionally on the live engine; every test that instantiates
 * PlanService must provide a mock that satisfies the full contract, not a
 * partial bag that a defensive `?.()` would tolerate.
 *
 * Tests spread overrides on top: `{ ...createMockPlanEngine(), buildDevicePlanSnapshot: ... }`.
 */
export const createMockPlanEngine = (options?: MockPlanEngineOptions) => ({
  state: createPlanEngineState(),
  buildDevicePlanSnapshot: vi.fn().mockResolvedValue({
    meta: buildPlanMeta({
      totalKw: 0,
      softLimitKw: 0,
      headroomKw: 0}),
    devices: [],
  } satisfies DevicePlan),
  computeDynamicSoftLimit: vi.fn(() => 0),
  computeShortfallThreshold: vi.fn(() => 0),
  handleShortfall: vi.fn().mockResolvedValue(undefined),
  handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
  applyPlanActions: vi.fn().mockResolvedValue({
    deviceWriteCount: 0, commandRequestCount: 0, deviceApplyFailureCount: 0, writtenDeviceIds: [],
  }),
  hasPendingTargetCommands: vi.fn(() => false),
  hasPendingTargetCommandsOlderThan: vi.fn(() => false),
  hasPendingBinaryCommands: vi.fn(() => false),
  syncPendingTargetCommands: vi.fn(() => false),
  syncPendingBinaryCommands: vi.fn(() => false),
  syncSteppedCommands: () => false,
  prunePendingTargetCommands: vi.fn(() => false),
  shouldApplyStablePlanActions: vi.fn(() => false),
  // Delegates to the REAL predicate rather than returning a canned value: a
  // `vi.fn(() => false)` default would silently switch every PlanService spec
  // to a no-op convergence check and hide regressions. It is pure (no I/O, no
  // clock), and fed the way production feeds it: readers, not a device list. A
  // spec that wants drift supplies the fixtures via `getDriftDevices`; one that
  // does not gets no observations, which the predicate skips rather than
  // treating as agreement.
  getObservationRevision: vi.fn(() => options?.getObservationRevision?.() ?? 0),
  hasExecutionWorkOutstanding: vi.fn(
    (plannedSnapshot: DevicePlan, observationRevisionAtBuild: number) => {
      // Mirrors the production gate: a plan decided against an older world is
      // not evidence about this one.
      if ((options?.getObservationRevision?.() ?? 0) !== observationRevisionAtBuild) return false;
      return hasPlanExecutionDriftAgainstIntent(
        plannedSnapshot,
        driftDepsFromPlanInputs(
          options?.getDriftDevices ?? (() => []),
          options?.getDriftBinaryCommand ?? (() => ({ kind: 'none' })),
        ),
      );
    },
  ),
  getDeviceExecutionStates: vi.fn((plan: DevicePlan) => new Map(plan.devices.map((device) => {
    const live = options?.getDriftDevices?.().find((candidate) => candidate.id === device.id);
    if (!live) return [device.id, executionStateFixture(device)];
    // Built the way the executor builds it: the observation from the live
    // device, whichever way it moved since the plan was built; the desired state
    // from the plan; in-flight binary state from the command store.
    const observed = live as PlanInputDevice & BinaryControlDiscriminantProbe
      & { currentOn?: boolean; reportedStepId?: string };
    const liveOn = observed.currentOn ?? observed.binaryControl?.on;
    const liveState = liveOn === true ? 'on' : 'off';
    const binaryCommand = options?.getDriftBinaryCommand?.(device.id) ?? { kind: 'none' };
    const fixture = {
      ...device,
      currentState: liveOn === undefined ? device.currentState : liveState,
      available: observed.available,
      ...(isMeteredPlanDevice(observed) ? { currentDrawKw: observed.currentDrawKw } : {}),
      ...('reportedStepId' in observed ? { reportedStepId: observed.reportedStepId } : {}),
      binaryCommandPending: binaryCommand.kind === 'pending' || undefined,
    } as typeof device;
    return [device.id, executionStateFixture(fixture)];
  }))),
  decoratePlanWithPendingTargetCommands: vi.fn((plan: DevicePlan) => plan),
  evaluateHeadroomForDevice: vi.fn<() => HeadroomForDeviceDecision>(),
  syncHeadroomCardState: vi.fn(() => false),
  syncHeadroomUsageObservation: vi.fn(() => false),
  beginStartupRestoreStabilization: vi.fn(),
  clearStartupRestoreStabilization: vi.fn(() => false),
});
