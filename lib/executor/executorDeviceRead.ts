/**
 * The executor's per-device read joins resolved DeviceConfiguration identity
 * with Observer's record of accepted device state. It never reads inventory
 * metadata or the transport snapshot, so it cannot consume a value Observer
 * has not accepted.
 *
 * The result contains the narrowed executor configuration, not the full config
 * source. Identity comes from DeviceConfiguration so a rename is visible even
 * when Observer's state did not change. If either owner has no record, the
 * device is not readable for this execution cycle.
 *
 * The observed half is the RECORD (`ObserverDeviceRead`), not the base state:
 * the stepped-load and drift projections read the reported step, measured power
 * and EV plug state off it, exactly as the drift check does.
 */
import type {
  EvObservedProbe,
  HomeBatteryObservedProbe,
  MeasuredPowerObservedProbe,
  ObservedDeviceState,
  ReportedStepObservedProbe,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { ExecutorDeviceSnapshot } from './executablePlan';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';

/**
 * The observer's live entry for one device, as the executor reads it. Widened
 * past the base type with the observed clusters the projection physically
 * carries, because this IS the producer-fed seam that reads them.
 */
export type ObserverDeviceRead = ObservedDeviceState
  & ReportedStepObservedProbe
  & MeasuredPowerObservedProbe
  & EvObservedProbe
  & HomeBatteryObservedProbe
  & { steppedLoadProfile?: SteppedLoadProfile };

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
    isEvCharger: configuration.isEvCharger,
    steppedLoadProfile: 'steppedLoadProfile' in configuration ? configuration.steppedLoadProfile : undefined,
  };
};
