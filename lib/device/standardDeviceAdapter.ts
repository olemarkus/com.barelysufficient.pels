import type { DeviceAdapter, DeviceAdapterSession, SwitchWrite } from './deviceAdapter';

const unrestrictedSession: DeviceAdapterSession = {
  observeDevice() {}, observeCapability() {}, retainDevices() {}, setTrustEpoch() {},
  observedIds: () => [], observes: () => false, controls: () => false,
  project: (snapshot) => snapshot, assertAllowed() {},
  controlEvents: (_id, capabilityId, value) => [{ capabilityId, value }],
};

/** Default behavior for standard Homey capabilities and unsupported integration facets. */
export const standardDeviceAdapter: DeviceAdapter = {
  matches: () => false, matchesCapabilities: () => false,
  identity: (device) => device,
  overlay: (_device, capabilities, capabilityObj) => ({ kind: 'standard', capabilities, capabilityObj }),
  normalize: (_snapshot, capabilityId, value) => [{ capabilityId, value }],
  observation: (device) => Object.fromEntries(
    Object.entries(device.capabilitiesObj ?? {}).flatMap(([id, capability]) => (
      capability === undefined ? [] : [[id, capability]]
    )),
  ),
  finalizeObservation: (_control, _capabilities, values) => values,
  readRules: () => ({}), retainsPlugObservation: () => false,
  phaseReport: () => ({ kind: 'not_reported' }), currentBindings: () => [],
  nativeCurrentControls: [], readBackAfterWrite: true,
  switchWrite: (snapshot, request): SwitchWrite => ({
    write: { ...request, capabilityId: snapshot.binaryWriteCapabilityId ?? request.capabilityId },
    readBackAsWritten: true,
  }),
  recoverSwitchWrite: (snapshot, _raw, request) => standardDeviceAdapter.switchWrite(snapshot, request),
  createSession: () => unrestrictedSession,
};
