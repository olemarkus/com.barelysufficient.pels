import { createTestDeviceActivityRecorder } from './deviceActivityRecorder';
import type { PlanServiceDeps } from '../../lib/plan/planServiceDeps';
import { SnapshotWarmupGate } from '../../lib/plan/snapshotWarmupGate';
import { testLogger } from '../utils/testLogger';

type PlanServiceWiring = Pick<PlanServiceDeps,
  | 'getAssociatedCarChargingState'
  | 'getObservedRecord'
  | 'getSteppedLoadProfileById'
  | 'schedulePostActuationRefresh'
  | 'structuredLog'
  | 'deviceOverviewLogRecorder'
  | 'emitsUiRealtime'
  | 'readStarvationRescuableDeviceIds'
  | 'snapshotWarmupGate'>;

/**
 * The plan-service deps `createPlanService` always wires, for a spec that is
 * not about them: no associated car, no stepped profiles, no structured logger,
 * the Main home's realtime channel, no rescuable device, and a warmup gate
 * that has already released. A spec about one of them overrides it. Debug
 * topics are the process-wide set: a spec reading a debug event captures it
 * with `captureLogger(level, topics)`.
 */
export const planServiceWiring = (): PlanServiceWiring => ({
  getAssociatedCarChargingState: () => undefined,
  getObservedRecord: () => undefined,
  getSteppedLoadProfileById: () => new Map(),
  schedulePostActuationRefresh: () => undefined,
  structuredLog: testLogger,
  deviceOverviewLogRecorder: createTestDeviceActivityRecorder(),
  emitsUiRealtime: true,
  readStarvationRescuableDeviceIds: () => [],
  snapshotWarmupGate: new SnapshotWarmupGate({ timeoutMs: 0 }),
});
