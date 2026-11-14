import type { ChargingCurrentSetup } from '../../../packages/contracts/src/chargingControl';
import type { AdapterUnavailableStatus } from '../../../packages/contracts/src/types';
import { resolveEvChargingStateLabel } from '../../../packages/shared-domain/src/evChargingStateLabel';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { DeviceAdapterSession, AdapterControlTarget, InventoryCompleteness } from '../deviceAdapter';
import {
  acknowledgedTeslaCurrent, hasTeslaChargingSurface, confirmedTeslaCurrent, isTeslaChargingState,
  resolveTeslaChargingState,
} from './charging';
import { ACKNOWLEDGED_CURRENT_CAPABILITY_ID } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { toCapabilityTimestampMs } from '../managerControl';
import { isTeslaChargingDevice, teslaDriver } from './identity';
import { getLogger } from '../../logging/logger';

import {
  lacksTeslaLocationDevice, resolveTeslaHomeEvidence, type HomeLocation, type TeslaHomeCheck, type TeslaHomeEvidence,
} from './evidence';

const logger = getLogger('device/tesla');

/** A connected car whose owner has not turned on vehicle charging control. */
const CONTROL_OFF_STATUS: AdapterUnavailableStatus = {
  kind: 'manual', factText: null,
  reasonText: 'Turn on “Control charging through this car” to let PELS control charging',
};

const isHomeEvidence = (evidence: TeslaHomeEvidence): boolean => (
  evidence.kind === 'home' || evidence.kind === 'home_without_location'
);

const manual = (factText: string | null, reasonText: string): AdapterUnavailableStatus => (
  { kind: 'manual', factText, reasonText }
);

const idle = (factText: string | null, reasonText: string): AdapterUnavailableStatus => (
  { kind: 'idle', factText, reasonText }
);

/**
 * Why PELS cannot place a car Homey still reports in a home session, as the
 * card's reason line. Every check names its cause, so the owner can tell a
 * sleeping car from a pairing gap.
 */
const NOT_HOME_REASONS: Readonly<Record<TeslaHomeCheck, string>> = {
  no_vehicle_id: 'Homey has no vehicle ID for this car',
  battery_unavailable: 'Homey reports this device unavailable',
  not_connected_state: 'The car has not reported its charging state',
  no_ac_cable: 'No AC charging cable is connected',
  dc_charging: 'The car is on a DC charger',
  no_location_device: 'Waiting for Homey to list the car’s devices',
  multiple_location_devices: 'More than one Location device matches this car',
  no_car_device: 'Add this car’s Car device from the Tesla app',
  multiple_car_devices: 'More than one Car device matches this car',
  car_unavailable: 'Homey reports the car’s Car device unavailable',
  car_not_online: 'The car is asleep or offline',
  car_moving: 'The car is driving',
  car_in_gear: 'The car is not in Park',
  location_unavailable: 'Homey reports the car’s Location device unavailable',
  no_car_coordinates: 'The car has not reported its location',
  no_home_coordinates: 'Set your Homey’s location so PELS can tell when the car is home',
  coordinates_undated: 'The car’s location has no time',
  coordinates_in_future: 'The car’s location has a time in the future',
};

// A car that is asleep, offline or driving is not charging; neither is one off an
// AC cable or in an unresolved state. Those read Idle with their cause. The rest
// may charge where PELS cannot control them (away, on DC, a pairing gap): Manual.
const IDLE_CHECKS: ReadonlySet<TeslaHomeCheck> = new Set([
  'not_connected_state', 'no_ac_cable', 'battery_unavailable', 'car_not_online', 'car_moving', 'car_in_gear',
]);

// The Tesla app reports `Calibrating` while the car prepares to charge; it has
// reported, it just is not charging yet.
const CALIBRATING_REASON = 'The car is preparing to charge';

const awayStatus = (
  evidence: TeslaHomeEvidence,
  state: unknown,
  plugLabel: string | null,
): AdapterUnavailableStatus => {
  if (evidence.kind === 'too_far') return manual(plugLabel, 'The car is not at home');
  // A home session never reaches here; this keeps the mapping total.
  if (evidence.kind !== 'failed') return idle(plugLabel, 'The car is not charging');
  const reason = state === 'Calibrating' ? CALIBRATING_REASON : NOT_HOME_REASONS[evidence.check];
  // A car still reporting Charging is never Idle, whichever check failed: the
  // card would read "Idle · Charging".
  const charging = state === 'Charging';
  return IDLE_CHECKS.has(evidence.check) && !charging ? idle(plugLabel, reason) : manual(plugLabel, reason);
};

const NUMERIC_OBSERVATIONS = new Set([
  'measure_location_latitude', 'measure_location_longitude', 'measure_car_drive_speed',
  'measure_charge_current_max', 'measure_charge_current', 'measure_charge_power', 'measure_charge_power_dc',
]);
const TEXT_OBSERVATIONS = new Set(['charging_port_cable', 'car_shift_state', 'car_state']);
function isObservationValue(id: string, value: unknown): boolean {
  if (id === 'charging_state') return isTeslaChargingState(value);
  if (NUMERIC_OBSERVATIONS.has(id)) return typeof value === 'number' && Number.isFinite(value);
  if (TEXT_OBSERVATIONS.has(id)) return typeof value === 'string';
  return id === 'charging_on' && typeof value === 'boolean';
}

/**
 * Home authorization holds while the vehicle's current observations show a
 * stationary AC session at home. A parked car's coordinates stay unchanged, so
 * their age is no evidence: only a contrary observation revokes it.
 */
export class TeslaChargingSession implements DeviceAdapterSession {
  private readonly devices = new Map<string, HomeyDeviceLike>();
  private trustEpoch = '';
  private readonly lastEvidence = new Map<string, string>();
  /** A complete device list was read since the last trust gap, so a companion it lacks is not paired. */
  private inventoryRead = false;

  constructor(private readonly home: HomeLocation) {}

  controls(snapshot: AdapterControlTarget): boolean { return hasTeslaChargingSurface(snapshot); }
  missingCompanion(deviceId: string): 'none' | 'vehicle_location' {
    return this.lacksLocationDevice(deviceId) ? 'vehicle_location' : 'none';
  }

  assertAllowed(device: HomeyDeviceLike, setup: ChargingCurrentSetup, connected: boolean): void {
    if (!isTeslaChargingDevice(device)) return;
    if (!connected) throw new Error('Tesla charging requires a connected Homey device feed.');
    if (setup.confirmation !== 'vehicle' || !this.isAllowed(device.id)) {
      throw new Error('Tesla charging requires a confirmed stationary AC charging session at home.');
    }
  }

  project(snapshot: TransportDeviceSnapshot, setup: ChargingCurrentSetup): TransportDeviceSnapshot {
    const evidence = this.homeEvidence(snapshot.id);
    const allowed = setup.confirmation === 'vehicle' && evidence !== undefined && isHomeEvidence(evidence);
    const controlAdapter = snapshot.controlAdapter && { ...snapshot.controlAdapter,
      unavailableStatus: allowed ? undefined : this.unavailableStatus(snapshot.id, setup, evidence),
    };
    if (allowed) return { ...snapshot, controlAdapter };
    // A connected vehicle outside the accepted home session contributes no home charging power.
    return { ...snapshot, controlAdapter, available: false, measuredPowerKw: 0 };
  }

  /**
   * What the card says while PELS does not control the car. Only Homey's own
   * unavailability, or no accepted reading after a trust gap, reads Unavailable:
   * a car Homey still reports is asleep, away, unplugged or done, and saying
   * Unavailable there read as PELS having lost it.
   */
  private unavailableStatus(
    deviceId: string,
    setup: ChargingCurrentSetup,
    evidence: TeslaHomeEvidence | undefined,
  ): AdapterUnavailableStatus {
    // A snapshot may already be projected. Only the accepted battery record
    // says whether Homey itself marked it unavailable; a trust gap clears it.
    const battery = this.devices.get(deviceId);
    if (!battery || evidence === undefined) {
      return { kind: 'unavailable', factText: null, reasonText: 'Waiting for Homey to report this device' };
    }
    if (battery.available === false) {
      return { kind: 'unavailable', factText: null, reasonText: 'Homey reports this device unavailable' };
    }
    const state = battery.capabilitiesObj.charging_state?.value;
    switch (state) {
      case 'Disconnected':
        return { kind: 'idle', factText: resolveEvChargingStateLabel('plugged_out'), reasonText: null };
      case 'Complete': return idle(resolveEvChargingStateLabel('plugged_in'), 'The car finished charging');
      case 'NoPower': return idle(null, 'The charger is not supplying power');
      default: break;
    }
    // With control turned off, PELS has not lost the car; it was not asked
    // to control it.
    if (setup.confirmation !== 'vehicle') return CONTROL_OFF_STATUS;
    return awayStatus(evidence, state, resolveEvChargingStateLabel(resolveTeslaChargingState(state)));
  }

  controlEvents(deviceId: string, capabilityId: string, value: unknown) {
    // The same vendor enum governs full reads, session evidence and emitted
    // feedback. A rejected state must not republish an old current observation.
    if (capabilityId === 'charging_state' && !isTeslaChargingState(value)) return [];
    const localValue = capabilityId === 'measure_charge_power' && !this.isAllowed(deviceId) ? 0 : value;
    const events = [{ capabilityId, value: localValue }];
    if (['measure_charge_current', 'measure_charge_current_max',
      'measure_charge_power', 'charging_on', 'charging_state']
      .includes(capabilityId)) {
      const current = this.confirmedCurrent(deviceId);
      if (current !== undefined) events.push({ capabilityId: 'available_installation_current', value: current });
    }
    // The limit echo acknowledges a command at once; it is published apart from
    // the confirmed current, which still waits for fresh actual measurements.
    if (capabilityId === 'measure_charge_current_max') {
      const acknowledged = this.acknowledgedCurrent(deviceId);
      if (acknowledged !== undefined) {
        events.push({ capabilityId: ACKNOWLEDGED_CURRENT_CAPABILITY_ID, value: acknowledged });
      }
    }
    return events;
  }

  observeDevices(devices: readonly HomeyDeviceLike[]): void {
    for (const device of devices) this.observeDevice(device);
  }

  retainDevices(devices: readonly HomeyDeviceLike[], inventory: InventoryCompleteness): void {
    this.inventoryRead = inventory === 'complete';
    const ids = new Set(devices.map((device) => device.id));
    for (const id of this.devices.keys()) if (!ids.has(id)) this.devices.delete(id);
    for (const id of this.lastEvidence.keys()) if (!ids.has(id)) this.lastEvidence.delete(id);
  }

  observeDevice(device: HomeyDeviceLike): void {
    if (teslaDriver(device) === undefined) return;
    const previous = this.devices.get(device.id);
    const capabilities = mergeCapabilities(previous, device);
    this.devices.set(device.id, { ...device, capabilitiesObj: capabilities });
  }

  observeCapability(deviceId: string, capabilityId: string, value: unknown): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const previous = device.capabilitiesObj[capabilityId];
    if (!isObservationValue(capabilityId, value)) return;
    this.observeDevice({ ...device, capabilitiesObj: {
      ...device.capabilitiesObj, [capabilityId]: { ...previous, value, lastUpdated: new Date().toISOString() },
    } });
  }

  confirmedCurrent(deviceId: string): number | undefined {
    const raw = this.devices.get(deviceId);
    return raw && isTeslaChargingDevice(raw)
      ? confirmedTeslaCurrent(raw.capabilitiesObj)?.value as number | undefined : undefined;
  }

  acknowledgedCurrent(deviceId: string): number | undefined {
    const raw = this.devices.get(deviceId);
    return raw && isTeslaChargingDevice(raw)
      ? acknowledgedTeslaCurrent(raw.capabilitiesObj)?.value as number | undefined : undefined;
  }

  observedIds(): string[] { return [...this.devices.keys()]; }

  withheldCapabilities(): readonly string[] { return []; }

  observes(deviceId: string): boolean { return this.devices.has(deviceId); }

  /** A trust gap discards what the feed reported before it; the next full read re-establishes it. */
  setTrustEpoch(epoch: string): void {
    if (epoch === this.trustEpoch) return;
    this.trustEpoch = epoch;
    this.devices.clear();
    this.inventoryRead = false;
  }

  /** The vehicle has no Location & navigation device in the last full device list. */
  lacksLocationDevice(deviceId: string): boolean {
    const battery = this.devices.get(deviceId);
    return this.inventoryRead && battery !== undefined && isTeslaChargingDevice(battery)
      && lacksTeslaLocationDevice(battery, [...this.devices.values()]);
  }

  isAllowed(deviceId: string): boolean {
    const evidence = this.homeEvidence(deviceId);
    return evidence !== undefined && isHomeEvidence(evidence);
  }

  /** Whether the car is in a home session, or undefined without an accepted battery record. */
  private homeEvidence(deviceId: string): TeslaHomeEvidence | undefined {
    const battery = this.devices.get(deviceId);
    if (!battery || !isTeslaChargingDevice(battery)) return undefined;
    // Away coordinates, motion, a disconnect or an unavailable companion fail this at once.
    const evidence = resolveTeslaHomeEvidence(battery, [...this.devices.values()], this.home, this.inventoryRead);
    this.logEvidenceChange(battery, evidence);
    return evidence;
  }

  /**
   * One line per change of outcome, because this runs on every projection. The
   * failing check is the only record of why a car at home is not controlled.
   */
  private logEvidenceChange(battery: HomeyDeviceLike, evidence: TeslaHomeEvidence): void {
    const outcome = evidence.kind === 'failed' ? evidence.check : evidence.kind;
    if (this.lastEvidence.get(battery.id) === outcome) return;
    this.lastEvidence.set(battery.id, outcome);
    logger.info({ event: 'tesla_home_evidence_changed', deviceId: battery.id, deviceName: battery.name, ...evidence });
  }
}

function mergeCapabilities(previous: HomeyDeviceLike | undefined, device: HomeyDeviceLike) {
  const accepted = Object.entries(device.capabilitiesObj).filter(([id, capability]) => {
    const time = toCapabilityTimestampMs(capability?.lastUpdated);
    const priorTime = toCapabilityTimestampMs(previous?.capabilitiesObj[id]?.lastUpdated);
    if (!capability || time === undefined || (priorTime !== undefined && time < priorTime)) return false;
    return isObservationValue(id, capability.value);
  });
  return { ...previous?.capabilitiesObj, ...Object.fromEntries(accepted) };
}
