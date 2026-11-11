import type { CapabilityRoute, CapabilityWrite, DeviceAdapter } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

// Stiebel Eltron heat pumps on the Stiebel Eltron Heat Pumps app
// (`Stiebel.heatpump` 1.5.3, `notes/native-wiring/stiebel.md`). One Homey
// device holds two loads: room heating on `target_temperature` /
// `measure_temperature`, and the hot-water tank on its own setpoint and
// reading. Power is split the same way: `measure_power` is the total and
// `measure_power.heating` / `.warmwater` its two parts. PELS reads the device
// as two: the room heating under the Homey id, and the hot water under
// `<id>~hot_water`, each with its own setpoint, temperature and power.

const HOT_WATER_SUFFIX = '~hot_water';

type WarmWaterPair = { target: string; measure: string };
const WARM_WATER_TEMP: WarmWaterPair = {
  target: 'target_temperature.warmwater_temp', measure: 'measure_temperature.warmwater_temp',
};
/** The drivers with a writable hot-water setpoint, and the capabilities each keeps it under. */
const WARM_WATER_BY_DRIVER: ReadonlyMap<string, WarmWaterPair> = new Map([
  ['homey:app:stiebel.heatpump:heatpump', WARM_WATER_TEMP],
  ['homey:app:stiebel.heatpump:heatpump-wpm3i', WARM_WATER_TEMP],
  ['homey:app:stiebel.heatpump:heatpump-lwz', {
    target: 'target_temperature.warmwater', measure: 'measure_temperature.warmwater',
  }],
]);

const TARGET = 'target_temperature';
const MEASURE = 'measure_temperature';
const POWER = 'measure_power';
const ENERGY = 'meter_power';
/** The total power and energy the room view keeps under its own name, read by nothing. */
const POWER_TOTAL = 'measure_power.total';
const ENERGY_TOTAL = 'meter_power.total';

const warmWaterPair = (device: HomeyDeviceLike): WarmWaterPair | undefined => (
  WARM_WATER_BY_DRIVER.get(device.driverId.trim().toLowerCase())
);

/** The pair, when the device declares both its halves: only then is the hot water its own view. */
function declaredWarmWaterPair(device: HomeyDeviceLike): WarmWaterPair | undefined {
  const pair = warmWaterPair(device);
  return pair && device.capabilities.includes(pair.target) && device.capabilities.includes(pair.measure)
    ? pair : undefined;
}

const isHotWaterView = (device: HomeyDeviceLike): boolean => device.id.endsWith(HOT_WATER_SUFFIX);

/** Vendor capability → the view's own name for it. */
type Renames = Readonly<Record<string, string>>;

function renamedView(device: HomeyDeviceLike, renames: Renames, keep: (capabilityId: string) => boolean) {
  const capabilities = device.capabilities.filter(keep).map((capabilityId) => renames[capabilityId] ?? capabilityId);
  const capabilitiesObj = Object.fromEntries(Object.entries(device.capabilitiesObj)
    .filter(([capabilityId]) => keep(capabilityId))
    .map(([capabilityId, entry]) => {
      const renamed = renames[capabilityId] ?? capabilityId;
      return [renamed, entry === undefined ? entry : { ...entry, id: renamed }];
    }));
  return { capabilities, capabilitiesObj };
}

/**
 * The parts replace the total only where the app declares them: a total the
 * part cannot replace stays the room's power. A part with no value (the app
 * fills the parts only from its community registers) stays empty; the total is
 * never copied onto it.
 */
function roomPowerRenames(device: HomeyDeviceLike): Renames {
  const declares = (capabilityId: string) => device.capabilities.includes(capabilityId);
  return {
    ...(declares('measure_power.heating') ? { [POWER]: POWER_TOTAL, 'measure_power.heating': POWER } : {}),
    ...(declares('meter_power.heating') ? { [ENERGY]: ENERGY_TOTAL, 'meter_power.heating': ENERGY } : {}),
  };
}

/**
 * The room view keeps the Homey id and every capability, with the heating
 * part as its power. The hot-water capabilities it still declares are read by
 * nothing on it: their reports go to the hot-water view (`routeStiebelReport`).
 */
function roomView(device: HomeyDeviceLike): HomeyDeviceLike {
  return { ...device, ...renamedView(device, roomPowerRenames(device), () => true) };
}

/** The hot-water view's names for the Homey device's capabilities. */
const hotWaterRenames = (pair: WarmWaterPair): Renames => ({
  [pair.target]: TARGET, [pair.measure]: MEASURE,
  'measure_power.warmwater': POWER, 'meter_power.warmwater': ENERGY,
});

function hotWaterView(device: HomeyDeviceLike, pair: WarmWaterPair): HomeyDeviceLike {
  const renames = hotWaterRenames(pair);
  return {
    ...device,
    id: `${device.id}${HOT_WATER_SUFFIX}`,
    name: `${device.name} hot water`,
    class: 'heater',
    virtualClass: null,
    settings: {},
    ...renamedView(device, renames, (capabilityId) => renames[capabilityId] !== undefined),
  };
}

function projectStiebelRead(device: HomeyDeviceLike): readonly HomeyDeviceLike[] {
  const pair = declaredWarmWaterPair(device);
  return pair ? [roomView(device), hotWaterView(device, pair)] : [device];
}

/** `device` is the accepted room view: it still declares the hot-water pair whenever the split applies. */
function routeStiebelReport(device: HomeyDeviceLike, capabilityId: string): CapabilityRoute {
  const pair = declaredWarmWaterPair(device);
  if (!pair) return { deviceId: device.id, capabilityId };
  const hotWaterCapability = hotWaterRenames(pair)[capabilityId];
  return hotWaterCapability === undefined
    ? { deviceId: device.id, capabilityId: roomReportName(device, capabilityId) }
    : { deviceId: `${device.id}${HOT_WATER_SUFFIX}`, capabilityId: hotWaterCapability };
}

/**
 * A room report by the room view's names (`roomPowerRenames`): the total goes
 * to the name the view keeps it under, the heating part to its power. The
 * accepted view's capabilities show which renames applied.
 */
function roomReportName(device: HomeyDeviceLike, capabilityId: string): string {
  if (capabilityId === POWER && device.capabilities.includes(POWER_TOTAL)) return POWER_TOTAL;
  if (capabilityId === ENERGY && device.capabilities.includes(ENERGY_TOTAL)) return ENERGY_TOTAL;
  if (capabilityId === 'measure_power.heating' && device.capabilities.includes(POWER_TOTAL)) return POWER;
  if (capabilityId === 'meter_power.heating' && device.capabilities.includes(ENERGY_TOTAL)) return ENERGY;
  return capabilityId;
}

const writeStiebelSetpoint = (view: HomeyDeviceLike, request: CapabilityWrite): CapabilityWrite => {
  const pair = warmWaterPair(view);
  return pair && isHotWaterView(view) && request.capabilityId === TARGET
    ? { ...request, capabilityId: pair.target } : request;
};

const stiebelSourceDeviceId = (view: HomeyDeviceLike): string => (
  isHotWaterView(view) ? view.id.slice(0, -HOT_WATER_SUFFIX.length) : view.id
);

export const stiebelHeatPumpAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => warmWaterPair(device) !== undefined,
  projectRead: projectStiebelRead,
  routeReport: routeStiebelReport,
  capabilityWrite: writeStiebelSetpoint,
  sourceDeviceId: stiebelSourceDeviceId,
};
