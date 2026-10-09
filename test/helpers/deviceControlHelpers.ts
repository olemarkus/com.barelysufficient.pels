import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { DeviceConfigurationStore } from '../../lib/device/deviceConfiguration';
import { TransportSnapshotStore } from '../../lib/device/transport/transportSnapshotStore';
import { admitFlowSteppedLoadReport } from '../../lib/device/transport/observationFlowStepped';
import { projectObservedState } from '../../lib/device/observedStateProjection';
import { DeviceTargetPowerReachabilityOwner } from '../../lib/device/deviceTargetPowerReachabilityOwner';
import { SteppedDeviceControl } from '../../lib/executor/steppedDeviceControl';
import { TargetPowerCommandLifecycle } from '../../lib/executor/targetPowerCommandLifecycle';
import { DeviceControlProjection } from '../../lib/planInput/deviceControlProjection';
import { resolveLatestPlanDesiredStepId } from '../../lib/plan/plannedSteppedCommand';
import type { Loggers } from '../../lib/logging/logger';
import type { DevicePlan } from '../../lib/plan/planTypes';
import type { TargetPowerConfigWithReachability } from '../../lib/device/targetPowerReachability';
import type { TargetPowerReachabilityState } from '../../packages/contracts/src/types';
import type { steppedStoresForTest } from './steppedStores';

/** A real owner admission and runtime composition over already resolved test snapshots. */
export function createDeviceControlHelpersForTest(
  readSnapshots: () => TransportDeviceSnapshot[],
  stores: ReturnType<typeof steppedStoresForTest>,
  readTargetPowerConfig: (deviceId: string) => TargetPowerConfigWithReachability | undefined,
  updateReachability: (deviceId: string, state: TargetPowerReachabilityState) => boolean,
  scheduleSettlement: (dueAtMs: number) => void,
  readPlan: () => DevicePlan | null,
  loggers: Loggers,
) {
  const configuration = new DeviceConfigurationStore();
  const snapshotStore = new TransportSnapshotStore();
  const refresh = () => {
    const snapshots = readSnapshots();
    snapshotStore.replaceSnapshot(snapshots);
    configuration.replace(snapshots);
  };
  const readConfiguration = (deviceId: string) => {
    refresh();
    return configuration.get(deviceId);
  };
  const readObserved = (deviceId: string) => {
    refresh();
    const snapshot = snapshotStore.getSnapshotByDeviceId(deviceId);
    return snapshot ? projectObservedState(snapshot) : undefined;
  };
  const targetPowerOwner = new DeviceTargetPowerReachabilityOwner(
    readTargetPowerConfig, readConfiguration, updateReachability,
  );
  const targetPower = new TargetPowerCommandLifecycle(stores.store, targetPowerOwner, scheduleSettlement, loggers);
  const control = new SteppedDeviceControl(stores.store, stores.reportedStore, {
    getDeviceConfiguration: readConfiguration,
    getDeviceConfigurations: () => { refresh(); return configuration.getAll(); },
    getObservedState: readObserved,
  }, targetPower, (deviceId, stepId, powerW) => {
    refresh();
    return admitFlowSteppedLoadReport(snapshotStore, configuration, () => {}, () => {}, deviceId, stepId, powerW);
  }, (deviceId, profile) => resolveLatestPlanDesiredStepId(readPlan(), deviceId, profile), loggers);
  const projection = new DeviceControlProjection(stores.store, {
    get: readConfiguration,
    getAll: () => { refresh(); return configuration.getAll(); },
    ids: () => { refresh(); return configuration.ids(); },
  }, readObserved, () => false, () => true);
  return {
    getSteppedLoadProfile: control.getSteppedLoadProfile.bind(control),
    getSteppedLoadCommandSession: control.getSteppedLoadCommandSession.bind(control),
    markSteppedLoadDesiredStepIssued: control.markSteppedLoadDesiredStepIssued.bind(control),
    hasPendingTargetPowerProbe: control.hasPendingTargetPowerProbe.bind(control),
    reconcileTargetPowerReachability: control.reconcileTargetPowerReachability.bind(control),
    reportSteppedLoadActualStep: control.reportSteppedLoadActualStep.bind(control),
    decorateTargetSnapshotList: projection.decorateTargetSnapshotList.bind(projection),
    getLifecycleFallbackDevice: projection.getLifecycleFallbackDevice.bind(projection),
  };
}
