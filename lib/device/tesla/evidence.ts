import { teslaDriver } from './identity';
import type { HomeyDeviceLike } from '../../utils/types';
import { toCapabilityTimestampMs } from '../managerControl';

import { readCoordinates, type Coordinates } from '../deviceCoordinates';
/** The hub's home coordinates; none until the first location read is accepted, so home authorization fails closed. */
export type HomeLocation = { coordinates(): Coordinates | undefined };

function distanceM(point: Coordinates, home: Coordinates): number {
  const radians = Math.PI / 180;
  const a = Math.sin((point.latitude - home.latitude) * radians / 2) ** 2
    + Math.cos(point.latitude * radians) * Math.cos(home.latitude * radians)
    * Math.sin((point.longitude - home.longitude) * radians / 2) ** 2;
  const boundedA = Math.min(1, Math.max(0, a));
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
}

/** The check that kept a Tesla battery out of a home charging session, for the log and nothing else. */
export type TeslaHomeCheck =
  | 'no_vehicle_id' | 'battery_unavailable' | 'not_connected_state' | 'no_ac_cable' | 'dc_charging'
  | 'no_location_device' | 'multiple_location_devices' | 'no_car_device' | 'multiple_car_devices'
  | 'car_unavailable' | 'car_not_online' | 'car_moving' | 'car_in_gear'
  | 'location_unavailable' | 'no_car_coordinates' | 'no_home_coordinates'
  | 'coordinates_undated' | 'coordinates_in_future';

/** Why a battery is or is not in a home session. Carries a distance from home, never a position. */
export type TeslaHomeEvidence =
  | { kind: 'home' }
  | { kind: 'failed'; check: TeslaHomeCheck }
  | { kind: 'too_far'; distanceFromHomeM: number };

const MAX_HOME_DISTANCE_M = 100;

function failed(check: TeslaHomeCheck): TeslaHomeEvidence {
  return { kind: 'failed', check };
}

/**
 * Called only for a car whose battery reports a connected AC cable, which a
 * Tesla cannot drive with. The app sets the shift state from a Fleet API poll
 * only; a car followed by telemetry can leave it unreported. An unreported
 * shift state therefore does not block home evidence, while a reported R, N
 * or D does.
 */
function stationaryOnlineCarFailure(car: HomeyDeviceLike): TeslaHomeCheck | undefined {
  if (car.available === false) return 'car_unavailable';
  const caps = car.capabilitiesObj;
  if (caps?.car_state?.value !== 'online') return 'car_not_online';
  if (caps.measure_car_drive_speed?.value !== 0) return 'car_moving';
  const shift = caps.car_shift_state?.value;
  return shift === 'P' || shift === '' || shift == null ? undefined : 'car_in_gear';
}

function connectedAcBatteryFailure(battery: HomeyDeviceLike): TeslaHomeCheck | undefined {
  if (battery.available === false) return 'battery_unavailable';
  const caps = battery.capabilitiesObj;
  if (!['Starting', 'Charging', 'Stopped'].includes(String(caps?.charging_state?.value))) return 'not_connected_state';
  if (!['IEC', 'SAE', 'GB_AC'].includes(String(caps?.charging_port_cable?.value))) return 'no_ac_cable';
  const dc = caps?.measure_charge_power_dc?.value;
  return dc == null || dc === 0 ? undefined : 'dc_charging';
}

/**
 * A dated, not future, coordinate pair within 100 m of home. Its age is no
 * evidence: Homey re-dates a coordinate only when it changes, so a parked car
 * keeps the date it arrived with.
 */
function locationEvidence(location: HomeyDeviceLike, home: HomeLocation): TeslaHomeEvidence {
  if (location.available === false) return failed('location_unavailable');
  const latitude = location.capabilitiesObj?.measure_location_latitude;
  const longitude = location.capabilitiesObj?.measure_location_longitude;
  const point = readCoordinates(latitude?.value, longitude?.value);
  if (!point) return failed('no_car_coordinates');
  const homePoint = home.coordinates();
  if (!homePoint) return failed('no_home_coordinates');
  const distance = distanceM(point, homePoint);
  if (distance > MAX_HOME_DISTANCE_M) return { kind: 'too_far', distanceFromHomeM: Math.round(distance) };
  const latitudeAt = toCapabilityTimestampMs(latitude?.lastUpdated);
  const longitudeAt = toCapabilityTimestampMs(longitude?.lastUpdated);
  if (latitudeAt === undefined || longitudeAt === undefined) return failed('coordinates_undated');
  return latitudeAt <= Date.now() && longitudeAt <= Date.now()
    ? { kind: 'home' } : failed('coordinates_in_future');
}

function soleCompanion(
  siblings: readonly HomeyDeviceLike[],
  driver: 'location' | 'car',
): HomeyDeviceLike | 'none' | 'multiple' {
  const matches = siblings.filter((device) => teslaDriver(device) === driver);
  if (matches.length === 0) return 'none';
  return matches.length === 1 ? matches[0]! : 'multiple';
}

/** Whether the vendor observations show a stationary AC session at home, or the first check that failed. */
export function resolveTeslaHomeEvidence(
  battery: HomeyDeviceLike,
  devices: readonly HomeyDeviceLike[],
  home: HomeLocation,
): TeslaHomeEvidence {
  const vehicleId = battery.data?.id;
  if (!vehicleId) return failed('no_vehicle_id');
  const batteryFailure = connectedAcBatteryFailure(battery);
  if (batteryFailure) return failed(batteryFailure);
  const siblings = devices.filter((device) => device.data?.id === vehicleId);
  const location = soleCompanion(siblings, 'location');
  if (location === 'none') return failed('no_location_device');
  if (location === 'multiple') return failed('multiple_location_devices');
  const car = soleCompanion(siblings, 'car');
  if (car === 'none') return failed('no_car_device');
  if (car === 'multiple') return failed('multiple_car_devices');
  const carFailure = stationaryOnlineCarFailure(car);
  return carFailure ? failed(carFailure) : locationEvidence(location, home);
}
