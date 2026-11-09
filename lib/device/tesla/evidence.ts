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

/**
 * Called only for a car whose battery reports a connected AC cable, which a
 * Tesla cannot drive with. The app sets the shift state from a Fleet API poll
 * only; a car followed by telemetry can leave it unreported. An unreported
 * shift state therefore does not block home evidence, while a reported R, N
 * or D does.
 */
function isStationaryOnlineCar(car: HomeyDeviceLike): boolean {
  if (!car.available) return false;
  const caps = car.capabilitiesObj;
  const shift = caps?.car_shift_state?.value;
  return caps?.car_state?.value === 'online' && caps.measure_car_drive_speed?.value === 0
    && (shift === 'P' || shift === '' || shift == null);
}

function isConnectedAcBattery(battery: HomeyDeviceLike): boolean {
  if (!battery.available) return false;
  const caps = battery.capabilitiesObj;
  if (!['Starting', 'Charging', 'Stopped'].includes(String(caps?.charging_state?.value))) return false;
  if (!['IEC', 'SAE', 'GB_AC'].includes(String(caps?.charging_port_cable?.value))) return false;
  const dc = caps?.measure_charge_power_dc?.value;
  return dc == null || dc === 0;
}

/**
 * A dated, not future, coordinate pair within 100 m of home. Its age is no
 * evidence: Homey re-dates a coordinate only when it changes, so a parked car
 * keeps the date it arrived with.
 */
function isAtHome(location: HomeyDeviceLike, home: HomeLocation): boolean {
  if (!location.available) return false;
  const latitude = location.capabilitiesObj.measure_location_latitude;
  const longitude = location.capabilitiesObj.measure_location_longitude;
  const point = readCoordinates(latitude?.value, longitude?.value);
  const homePoint = home.coordinates();
  if (!point || !homePoint || distanceM(point, homePoint) > 100) return false;
  const latitudeAt = toCapabilityTimestampMs(latitude?.lastUpdated);
  const longitudeAt = toCapabilityTimestampMs(longitude?.lastUpdated);
  if (latitudeAt === undefined || longitudeAt === undefined) return false;
  return latitudeAt <= Date.now() && longitudeAt <= Date.now();
}

/** Whether the vendor observations show a stationary AC charging session at home. */
export function hasTeslaHomeEvidence(
  battery: HomeyDeviceLike,
  devices: readonly HomeyDeviceLike[],
  home: HomeLocation,
): boolean {
  const vehicleId = battery.data.id;
  if (!vehicleId || !isConnectedAcBattery(battery)) return false;
  const siblings = devices.filter((device) => device.data.id === vehicleId);
  const locations = siblings.filter((device) => teslaDriver(device) === 'location');
  const cars = siblings.filter((device) => teslaDriver(device) === 'car');
  const location = locations.length === 1 ? locations[0] : undefined;
  const car = cars.length === 1 ? cars[0] : undefined;
  if (!location || !car || !isStationaryOnlineCar(car)) return false;
  return isAtHome(location, home);
}
