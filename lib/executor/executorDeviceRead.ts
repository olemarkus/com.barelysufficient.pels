/**
 * The executor's per-device read, composed from the two layers that own its
 * halves: the transport's DESCRIPTOR (identity and config) and the observer's
 * OBSERVED record (what the device is doing). Stage 5 of the snapshot
 * decomposition (`notes/state-management/snapshot-decomposition.md`): the
 * executor no longer pulls the transport's raw snapshot, so nothing here can
 * read an observation the projection has not recorded.
 *
 * The join is deliberately thin — one spread per device. The two halves share
 * only `id`/`name`, and that is a property of the PRODUCERS, not of this file:
 * the descriptor is `projectDeviceDescriptor`'s output, which physically
 * carries descriptor keys and nothing else, so the spread cannot pick up an
 * observed field the projection has not recorded. A descriptor that was merely
 * the snapshot under a narrower type would break exactly that. The descriptor
 * goes last so identity is the transport's: a rename arrives as a device.update
 * with no observed change, which the projection is not told about. It resolves
 * nothing: both halves arrive resolved by their owners, and a device with
 * either half missing is not readable this cycle, which is the same answer the
 * dispatch path already gives for a device absent from the snapshot between
 * planning and dispatch.
 *
 * The observed half is the RECORD (`ObserverDeviceRead`), not the base state:
 * the stepped-load and drift projections read the reported step, measured power
 * and EV plug state off it, exactly as the drift check does.
 */
import type {
  EvObservedProbe,
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
} from '../../packages/contracts/src/types';
import type { ObserverDeviceRead } from './driftObservedDevice';
import type { ExecutorDeviceSnapshot } from './executablePlan';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';

/**
 * What the executor holds for one device: the narrowed executor surface plus
 * the observed clusters the projection physically carries. Every actuation
 * path builds its `ExecutableObservedDeviceState` from this.
 */
export type ExecutorDeviceRead = ExecutorDeviceSnapshot
  & ReportedStepObservedProbe
  & MeasuredPowerObservedProbe
  & EvObservedProbe;

/**
 * The executor's two owner reads. The final executor read keeps only the
 * configuration fields it consumes and joins them to Observer's live record.
 */
export type ExecutorDeviceReadDeps = {
  /** Runtime configuration source; `undefined` for an untracked device. */
  getDeviceConfiguration: (deviceId: string) => DeviceConfigurationRead | undefined;
  /** Every tracked runtime configuration, in snapshot order. */
  getDeviceConfigurations: () => DeviceConfigurationRead[];
  /**
   * Observer-owned observed record, live. `undefined` until the first
   * observation for a device lands.
   */
  getObservedState: (deviceId: string) => ObserverDeviceRead | undefined;
};

export function readExecutorDevice(
  deps: ExecutorDeviceReadDeps,
  deviceId: string,
): ExecutorDeviceRead | undefined {
  const configuration = deps.getDeviceConfiguration(deviceId);
  if (!configuration) return undefined;
  return joinExecutorDevice(configuration, deps.getObservedState(deviceId));
}

export function readExecutorDevices(deps: ExecutorDeviceReadDeps): ExecutorDeviceRead[] {
  return deps.getDeviceConfigurations().flatMap((source) => {
    const device = joinExecutorDevice(source, deps.getObservedState(source.id));
    return device ? [device] : [];
  });
}

const joinExecutorDevice = (
  configuration: DeviceConfigurationRead,
  observed: ObserverDeviceRead | undefined,
): ExecutorDeviceRead | undefined => {
  if (!observed) return undefined;
  return {
    ...observed,
    id: configuration.id,
    name: configuration.name,
  };
};
