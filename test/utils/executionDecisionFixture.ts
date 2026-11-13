import type { DevicePlan, DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildExecutionPlan, buildExecutableDeviceIntent as produceCommands,
  hasExecutableShedDevices } from '../../lib/plan/planExecutionProjection';
import { buildPlannedSteppedCommand, resolveSteppedLoadCurrentFallback } from '../../lib/plan/planSteppedCommand';
import type { ExecutableSteppedLoadCommandSession } from '../../lib/executor/executablePlan';
import { buildPlanMeta } from './planTestUtils';

/** Separate the command-owner fixture from the historical planner facts. */
export function commandSessionForFixture(device: Partial<DevicePlanDevice>): ExecutableSteppedLoadCommandSession {
  return {
    command: device.lastDesiredStepId ? {
      stepId: device.lastDesiredStepId,
      status: device.stepCommandPending ? 'pending' : (device.stepCommandStatus ?? 'idle'),
      retryCount: device.stepCommandRetryCount ?? 0,
      nextRetryAtMs: device.nextStepCommandRetryAtMs,
    } : undefined,
    hasPriorStepCommand: device.lastDesiredStepId !== undefined,
    reportedStepId: device.reportedStepId,
    stepCommandPending: device.stepCommandPending === true,
    unansweredStepCommands: { kind: 'none' },
  };
}

/** Exercise the real decision producer; the executor reads its command session beside it. */
export function buildExecutableDeviceIntent(device: DevicePlanDevice, meta?: DevicePlan['meta']) {
  return produceCommands(device, meta);
}
export function buildExecutablePlan(plan: DevicePlan) {
  return { devices: plan.devices.map((device) => buildExecutableDeviceIntent(device, plan.meta)) };
}
export function buildExecutableSteppedLoadIntent(device: DevicePlanDevice) {
  return buildPlannedSteppedCommand(device);
}
export { hasExecutableShedDevices, resolveSteppedLoadCurrentFallback };

/** The same owner projection used by production, for a one-device drift assertion. */
export function executionDeviceForFixture(device: DevicePlanDevice) {
  return buildExecutionPlan({ meta: buildPlanMeta(), devices: [device], chargingPhaseDecisions: [], inverterDecisions: [], storageReleases: [] }).devices[0]!;
}
