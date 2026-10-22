import { vi } from 'vitest';
import { createTestDeviceActivityRecorder } from './deviceActivityRecorder';
import type { PlanServiceDeps } from '../../lib/plan/planServiceDeps';
import { SnapshotWarmupGate } from '../../lib/plan/snapshotWarmupGate';

type PlanServiceWiring = Pick<PlanServiceDeps,
  | 'getAssociatedCarChargingState'
  | 'getObservedRecord'
  | 'getSteppedLoadProfileById'
  | 'schedulePostActuationRefresh'
  | 'loggers'
  | 'overviewDebugStructured'
  | 'isOverviewDebugEnabled'
  | 'deviceOverviewLogRecorder'
  | 'isPlanDebugEnabled'
  | 'emitsUiRealtime'
  | 'snapshotWarmupGate'>;

/**
 * The plan-service deps `createPlanService` always wires, for a spec that is
 * not about them: no associated car, no stepped profiles, no structured logger,
 * the overview debug topic off (the plan topic on, so plan debug summaries
 * reach `loggers.debugStructured`), the Main home's realtime channel, and a
 * warmup gate that has already released. A spec about one of them overrides it.
 */
export const planServiceWiring = (): PlanServiceWiring => ({
  getAssociatedCarChargingState: () => undefined,
  getObservedRecord: () => undefined,
  getSteppedLoadProfileById: () => new Map(),
  schedulePostActuationRefresh: () => undefined,
  loggers: { debugStructured: vi.fn() },
  overviewDebugStructured: vi.fn(),
  isOverviewDebugEnabled: () => false,
  deviceOverviewLogRecorder: createTestDeviceActivityRecorder(),
  isPlanDebugEnabled: () => true,
  emitsUiRealtime: true,
  snapshotWarmupGate: new SnapshotWarmupGate({ timeoutMs: 0 }),
});
