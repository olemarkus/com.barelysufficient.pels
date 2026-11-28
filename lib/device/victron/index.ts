import type { EvChargingState } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceAdapter, DeviceAdapterSession } from '../deviceAdapter';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const APP = 'homey:app:com.victronenergy';
const STATUS = 'sensor_status';
const MODE = 'sensor_status.mode';
const CURRENT_CEILING = 'measure_current.max';
const CHARGING = 'evcharger_charging';
const PLUG = 'evcharger_charging_state';

const matches = (device: HomeyDeviceLike): boolean => (
  device.driverId === `${APP}:evcharger` || device.driverId === 'com.victronenergy:evcharger'
);

const plugStates: ReadonlyMap<unknown, EvChargingState> = new Map([
  ['Disconnected', 'plugged_out'],
  ['Connected', 'plugged_in_waiting_for_charger'],
  ['Charging', 'plugged_in_charging'],
  ['Charged', 'plugged_in_finished'],
  ['Waiting for start', 'plugged_in_awaiting_start'],
  ['Waiting for sun', 'plugged_in_waiting_for_charger'],
  ['Waiting for RFID', 'plugged_in_waiting_for_charger'],
  ['Low SOC', 'plugged_in_waiting_for_charger'],
]);

function binaryState(status: unknown): boolean | undefined {
  if (status === 'Charging') return true;
  if (status === 'Disconnected' || status === 'Waiting for start') return false;
  return undefined;
}

function withObservations(values: DeviceCapabilityMap): DeviceCapabilityMap {
  const { [CHARGING]: charging, [PLUG]: plug, ...independent } = values;
  const status = values[STATUS];
  if (!status || toCapabilityTimestampMs(status.lastUpdated) === undefined) return independent;
  const state = plugStates.get(status.value);
  const on = binaryState(status.value);
  return {
    ...independent,
    ...(state === undefined ? {} : { [PLUG]: { ...plug, value: state, lastUpdated: status.lastUpdated } }),
    ...(on === undefined || charging === undefined ? {}
      : { [CHARGING]: { ...charging, value: on, lastUpdated: status.lastUpdated } }),
  };
}

function currentCeiling(device: HomeyDeviceLike): number | undefined {
  const ceiling = device.capabilitiesObj[CURRENT_CEILING];
  if (!ceiling || toCapabilityTimestampMs(ceiling.lastUpdated) === undefined) return undefined;
  const { value } = ceiling;
  return typeof value === 'number' && Number.isFinite(value) && value >= 6
    ? Math.min(32, Math.floor(value)) : undefined;
}

type FieldRead = { value: string; observedAtMs: number; receivedAtMs: number };

type ControlEvidence = {
  mode?: FieldRead;
  status?: FieldRead;
  availability: { value: boolean; receivedAtMs: number };
  epoch: number;
  selected: boolean;
};

function canControl(evidence: ControlEvidence | undefined): boolean {
  return evidence?.availability.value === true && evidence.mode?.value === 'Manual'
    && (evidence.status?.value === 'Charging' || evidence.status?.value === 'Waiting for start');
}

function acceptSnapshotField(
  previous: FieldRead | undefined, reading: DeviceCapabilityMap[string] | undefined, readAtMs: number,
): FieldRead | undefined {
  const observedAtMs = toCapabilityTimestampMs(reading?.lastUpdated);
  if (typeof reading?.value !== 'string' || observedAtMs === undefined) return previous;
  if (previous && (previous.receivedAtMs > readAtMs || previous.observedAtMs > observedAtMs)) return previous;
  return { value: reading.value, observedAtMs, receivedAtMs: readAtMs };
}

function changesAuthority(previous: ControlEvidence, next: ControlEvidence): boolean {
  if (previous.mode?.value !== next.mode?.value || previous.availability.value !== next.availability.value) return true;
  // A preparation remains valid when its own start moves Waiting for start to Charging.
  return previous.status?.value !== next.status?.value
    && !(previous.status?.value === 'Waiting for start' && next.status?.value === 'Charging');
}

function createSession(home: Parameters<DeviceAdapter['createSession']>[0]): DeviceAdapterSession {
  const devices = new Map<string, ControlEvidence>();
  let epoch = 0;
  let trust = '';
  let trustChangedAtMs = 0;
  function observe(id: string, next: ControlEvidence): void {
    const prior = devices.get(id);
    const changed = prior === undefined || changesAuthority(prior, next);
    devices.set(id, changed ? { ...next, epoch: ++epoch } : next);
  }
  return {
    ...standardDeviceAdapter.createSession(home),
    observeDevice: (device, readAtMs) => {
      if (!matches(device) || readAtMs < trustChangedAtMs) return;
      const prior = devices.get(device.id);
      observe(device.id, {
        mode: acceptSnapshotField(prior?.mode, device.capabilitiesObj[MODE], readAtMs),
        status: acceptSnapshotField(prior?.status, device.capabilitiesObj[STATUS], readAtMs),
        availability: prior && prior.availability.receivedAtMs > readAtMs
          ? prior.availability : { value: device.available, receivedAtMs: readAtMs },
        selected: prior?.selected ?? false,
        epoch: prior?.epoch ?? 0,
      });
    },
    observeCapability: (id, capabilityId, value) => {
      const prior = devices.get(id);
      if (!prior || typeof value !== 'string') return;
      const now = Date.now();
      const reading = { value, observedAtMs: now, receivedAtMs: now };
      if (capabilityId === MODE) observe(id, { ...prior, mode: reading });
      if (capabilityId === STATUS) observe(id, { ...prior, status: reading });
    },
    setTrustEpoch: (value) => {
      if (value === trust) return;
      if (trust) trustChangedAtMs = Date.now();
      trust = value;
      devices.forEach(({ selected }, id) => devices.set(id, {
        selected, epoch: ++epoch, availability: { value: false, receivedAtMs: trustChangedAtMs },
      }));
    },
    retainDevices: (inventory, coverage) => {
      if (coverage !== 'complete') return;
      const present = new Set(inventory.map((device) => device.id));
      for (const id of devices.keys()) if (!present.has(id)) devices.delete(id);
    },
    controls: (snapshot) => devices.has(snapshot.id),
    project: (snapshot) => {
      const evidence = devices.get(snapshot.id);
      const control = snapshot.controlAdapter;
      if (!evidence || !control) return snapshot;
      const selected = control.currentControl === 'built_in';
      if (selected !== evidence.selected) {
        const changed = { ...evidence, selected, epoch: ++epoch };
        devices.set(snapshot.id, changed);
        return projectControl(snapshot, changed);
      }
      return projectControl(snapshot, evidence);
    },
    assertAllowed: (device, _setup, connected) => {
      if (!matches(device)) return;
      if (!connected || !canControl(devices.get(device.id))) {
        throw new Error('Victron charging control requires Manual mode and a charger ready to start or charging.');
      }
    },
  };
}

function projectControl(snapshot: Parameters<DeviceAdapterSession['project']>[0], evidence: ControlEvidence) {
  const control = snapshot.controlAdapter;
  if (!control) return snapshot;
  const { currentActionEpoch: _previous, unavailableStatus: _status, activationOrder: _order, ...rest } = control;
  const route = evidence.selected ? { ...rest, activationOrder: 'current_before_start' as const } : rest;
  if (canControl(evidence)) {
    return {
      ...snapshot,
      controlAdapter: { ...route, ...(evidence.selected ? { currentActionEpoch: evidence.epoch } : {}) },
    };
  }
  return { ...snapshot, controlAdapter: { ...route, unavailableStatus: unavailableStatus(snapshot, evidence) } };
}

function unavailableStatus(snapshot: Parameters<DeviceAdapterSession['project']>[0], evidence: ControlEvidence) {
  if (!snapshot.available) {
    return { kind: 'unavailable' as const, factText: null, reasonText: 'Homey reports this device unavailable' };
  }
  if (evidence.mode?.value === 'Auto') {
    return { kind: 'manual' as const, factText: null, reasonText: 'Set the charger to Manual in the Victron app' };
  }
  return { kind: 'idle' as const, factText: null, reasonText: null };
}

export const victronEvChargerAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches,
  matchesCapabilities: (capabilities) => capabilities.includes(STATUS) && capabilities.includes(MODE)
    && capabilities.includes(CURRENT_CEILING) && capabilities.includes(CHARGING),
  currentBindings: (device) => matches(device) ? [{
    deviceId: device.id,
    current: { kind: 'action_only' },
    appUri: APP,
    actionId: 'set_evcharger_current',
    scope: { kind: 'charger' },
    sharesInstallation: () => false,
    supportsAppAction: currentCeiling(device) !== undefined,
    confirmsCurrentWithAction: true,
    actionCurrentCeilingA: currentCeiling(device),
    currentArguments: (current) => ({ current }),
  }] : [],
  readRules: () => ({ [MODE]: 'string', [STATUS]: 'string', [CURRENT_CEILING]: 'number' }),
  overlay: (_device, capabilities, values) => {
    const capabilityObj = withObservations(values);
    return {
      kind: 'adapted',
      capabilities: capabilities.filter((id) => id !== PLUG && id !== CHARGING || capabilityObj[id] !== undefined),
      capabilityObj,
      controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
      binaryTarget: { kind: 'canonical' },
    };
  },
  observation: (device) => withObservations(standardDeviceAdapter.observation(device)),
  normalize: (_snapshot, capabilityId, value) => {
    if (capabilityId === PLUG || capabilityId === CHARGING) return [];
    if (capabilityId !== STATUS) return [{ capabilityId, value }];
    const state = plugStates.get(value);
    const on = binaryState(value);
    return [
      ...(state === undefined ? [] : [{ capabilityId: PLUG, value: state }]),
      ...(on === undefined ? [] : [{ capabilityId: CHARGING, value: on }]),
    ];
  },
  switchWrite: (snapshot, request) => ({
    ...standardDeviceAdapter.switchWrite(snapshot, request), readBackAsWritten: false,
  }),
  recoverSwitchWrite: (snapshot, _device, request) => victronEvChargerAdapter.switchWrite(snapshot, request),
  createSession,
};
