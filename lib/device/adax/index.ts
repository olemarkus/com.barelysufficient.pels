import type { CapabilityUpdate, DeviceAdapter } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { CapabilityValue, HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

// Adax Wi-Fi heaters, Adax app 2.0.6 (`drivers/heater-wt`). The heater has no
// power meter. The app writes `measure_power` as the rated power from its
// `ratedPower` setting whenever the heater's local status says it heats, and
// never writes 0, so once a heater has heated, Homey reports its rated power
// forever. PELS reads the draw from the heater's own state instead: rated
// power while it is on and below its target, 0 once it is off or has reached
// it. A setback write therefore reads as relief at once.
const ADAX_HEATER_DRIVER_ID = 'homey:app:no.adax.smart-heater.homey-app:heater-wt';
// The app's own default when the owner never set a rating.
const DEFAULT_RATED_POWER_W = 1000;
const POWER = 'measure_power';
type CapabilityValues = Readonly<Record<string, CapabilityValue<unknown> | undefined>>;

const DRAW_INPUTS: readonly string[] = ['onoff', 'target_temperature', 'measure_temperature'];

const isAdaxHeater = (device: HomeyDeviceLike): boolean => device.driverId === ADAX_HEATER_DRIVER_ID;

const ratedPowerW = (device: HomeyDeviceLike): number => {
  const { ratedPower } = device.settings;
  return typeof ratedPower === 'number' && Number.isFinite(ratedPower) && ratedPower > 0
    ? ratedPower : DEFAULT_RATED_POWER_W;
};

const readNumber = (values: CapabilityValues, capabilityId: string): number | undefined => {
  const value = values[capabilityId]?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/** On and below target draws the rating; a heater with no reading yet is taken as heating. */
function drawW(device: HomeyDeviceLike, values: CapabilityValues): number {
  if (values.onoff?.value !== true) return 0;
  const temperature = readNumber(values, 'measure_temperature');
  const target = readNumber(values, 'target_temperature');
  if (temperature !== undefined && target !== undefined && temperature >= target) return 0;
  return ratedPowerW(device);
}

const stampMs = (stamp: unknown): number | undefined => {
  if (stamp === null || stamp === undefined) return undefined;
  const ms = new Date(stamp as string | number | Date).getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * The draw is as recent as the newest state it was worked out from. Homey's
 * own `measure_power` stamp is left out: the app republishes the rating on
 * its own schedule, which says nothing about the state read here.
 */
function newestInputStamp(values: DeviceCapabilityMap): string | undefined {
  const stamps = DRAW_INPUTS
    .map((capabilityId) => stampMs(values[capabilityId]?.lastUpdated))
    .filter((ms): ms is number => ms !== undefined);
  return stamps.length > 0 ? new Date(Math.max(...stamps)).toISOString() : undefined;
}

function withDraw(device: HomeyDeviceLike, values: DeviceCapabilityMap): DeviceCapabilityMap {
  const lastUpdated = newestInputStamp(values);
  return {
    ...values,
    [POWER]: { ...values[POWER], id: POWER, value: drawW(device, values), ...(lastUpdated ? { lastUpdated } : {}) },
  };
}

// The report itself is read too: Homey's echo of PELS's own setback is not
// kept on the device's accepted read, yet the heater has taken the target.
function normalizeAdaxUpdate(
  device: HomeyDeviceLike, capabilityId: string, value: unknown,
): CapabilityUpdate[] {
  const values = DRAW_INPUTS.includes(capabilityId)
    ? { ...device.capabilitiesObj, [capabilityId]: { ...device.capabilitiesObj[capabilityId], value } }
    : device.capabilitiesObj;
  const draw = { capabilityId: POWER, value: drawW(device, values) };
  if (capabilityId === POWER) return [draw];
  return DRAW_INPUTS.includes(capabilityId) ? [{ capabilityId, value }, draw] : [{ capabilityId, value }];
}

export const adaxAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isAdaxHeater,
  overlay: (device, capabilities, capabilityObj) => ({
    kind: 'standard',
    capabilities: capabilities.includes(POWER) ? capabilities : [...capabilities, POWER],
    capabilityObj: withDraw(device, capabilityObj),
  }),
  normalize: (_snapshot, capabilityId, value, device) => normalizeAdaxUpdate(device, capabilityId, value),
};
