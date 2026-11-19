import type { DeviceAdapter, DeviceAdapterSession, SwitchWrite } from './deviceAdapter';
import { STANDARD_HOME_BATTERY_BINDING } from './homeBatteryBinding';
import { resolveMeterPhases } from './meterPhases';

const unrestrictedSession: DeviceAdapterSession = {
  chargingInstallationOf: () => undefined,
  observeDevice() {}, observeCapability() {}, retainDevices() {}, withheldCapabilities: () => [], setTrustEpoch() {},
  observedIds: () => [], observes: () => false, controls: () => false,
  missingCompanion: () => 'none',
  project: (snapshot) => snapshot, assertAllowed() {},
  controlEvents: (_id, capabilityId, value) => [{ capabilityId, value }],
  observeRefusedWrite: () => false, observeAcceptedWrite: () => false,
};

/** Default behavior for standard Homey capabilities and unsupported integration facets. */
export const standardDeviceAdapter: DeviceAdapter = {
  matches: () => false, matchesCapabilities: () => false,
  identity: (device) => device,
  overlay: (_device, capabilities, capabilityObj) => ({ kind: 'standard', capabilities, capabilityObj }),
  configureTargetPower: (_device, config) => config,
  targetPowerReading: (_device, _config, value) => value,
  stepCommand: (_device, _step, command) => command,
  stepActivationOrder: 'start_before_current',
  normalize: (_snapshot, capabilityId, value) => [{ capabilityId, value }],
  observation: (device) => Object.fromEntries(
    Object.entries(device.capabilitiesObj).flatMap(([id, capability]) => (
      capability === undefined ? [] : [[id, capability]]
    )),
  ),
  finalizeObservation: (_control, _capabilities, values) => values,
  readRules: () => ({}), retainsPlugObservation: () => false,
  phaseReport: () => ({ kind: 'not_reported' }), currentBindings: () => [], phaseBindings: () => [],
  installationLevelW: () => undefined, installationWattsPerAmp: () => undefined,
  nativeCurrentControls: [], nativeLevelControls: [], homeBatteryBinding: () => STANDARD_HOME_BATTERY_BINDING,
  meterMonthlyPeak: () => ({ state: 'none' }),
  meterPhases(device, ownerChoice) {
    const [view] = this.projectRead(device);
    return view === undefined ? { state: 'unavailable' } : resolveMeterPhases(view, ownerChoice);
  },
  readBackAfterWrite: true, supportsProductionLimits: true,
  projectRead: (device) => [device],
  routeReport: (device, capabilityId) => ({ deviceId: device.id, capabilityId }),
  capabilityWrite: (_view, request) => request,
  sourceDeviceId: (view) => view.id,
  switchWrite: (snapshot, request): SwitchWrite => ({
    kind: 'write',
    write: { ...request, capabilityId: snapshot.binaryWriteCapabilityId ?? request.capabilityId },
    readBackAsWritten: true,
  }),
  recoverSwitchWrite: (snapshot, _raw, request) => standardDeviceAdapter.switchWrite(snapshot, request),
  createSession: () => unrestrictedSession,
};

/** A device no integration claims, read as Homey reports it. */
export const plainDeviceAdapter: DeviceAdapter = { ...standardDeviceAdapter };
