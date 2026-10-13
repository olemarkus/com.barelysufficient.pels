import type { HomeyDeviceLike } from '../utils/types';
import { toCapabilityTimestampMs } from './managerControl';

export type HomeLocation = { getLatitude(): number; getLongitude(): number };
export type HomeSessionIdentity = { vehicleId: string; locationId: string; carId: string };
export type HomeSessionEvidence = { identity: HomeSessionIdentity; coordinateAtMs: number };
type Coordinates = { latitude: number; longitude: number };

function readCoordinates(latitude: unknown, longitude: unknown): Coordinates | undefined {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return undefined;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

function distanceM(point: Coordinates, home: Coordinates): number {
  const radians = Math.PI / 180;
  const a = Math.sin((point.latitude - home.latitude) * radians / 2) ** 2
    + Math.cos(point.latitude * radians) * Math.cos(home.latitude * radians)
    * Math.sin((point.longitude - home.longitude) * radians / 2) ** 2;
  const boundedA = Math.min(1, Math.max(0, a));
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
}

function isStationaryOnlineCar(car: HomeyDeviceLike): boolean {
  if (car.available === false) return false;
  const caps = car.capabilitiesObj;
  const shift = caps?.car_shift_state?.value;
  return caps?.car_state?.value === 'online' && caps.measure_car_drive_speed?.value === 0
    && (shift === 'P' || shift === '');
}

function isConnectedAcBattery(battery: HomeyDeviceLike): boolean {
  if (battery.available === false) return false;
  const caps = battery.capabilitiesObj;
  if (!['Starting', 'Charging', 'Stopped'].includes(String(caps?.charging_state?.value))) return false;
  if (!['IEC', 'SAE', 'GB_AC'].includes(String(caps?.charging_port_cable?.value))) return false;
  const dc = caps?.measure_charge_power_dc?.value;
  return dc == null || dc === 0;
}

function readHome(home: HomeLocation): Coordinates | undefined {
  try { return readCoordinates(home.getLatitude(), home.getLongitude()); }
  catch { return undefined; }
}

function readHomeLocationEvidence(location: HomeyDeviceLike, home: HomeLocation): number | undefined {
  if (location.available === false) return undefined;
  const latitude = location.capabilitiesObj?.measure_location_latitude;
  const longitude = location.capabilitiesObj?.measure_location_longitude;
  const point = readCoordinates(latitude?.value, longitude?.value);
  const homePoint = readHome(home);
  if (!point || !homePoint || distanceM(point, homePoint) > 100) return undefined;
  const latitudeAt = toCapabilityTimestampMs(latitude?.lastUpdated);
  const longitudeAt = toCapabilityTimestampMs(longitude?.lastUpdated);
  if (latitudeAt === undefined || longitudeAt === undefined) return undefined;
  if (latitudeAt > Date.now() || longitudeAt > Date.now()) return undefined;
  return Math.min(latitudeAt, longitudeAt);
}

/** Resolves vendor observations into affirmative home-session evidence. */
export function readTeslaHomeEvidence(
  battery: HomeyDeviceLike,
  devices: readonly HomeyDeviceLike[],
  home: HomeLocation,
): HomeSessionEvidence | undefined {
  const vehicleId = battery.data?.id;
  if (!vehicleId || !isConnectedAcBattery(battery)) return undefined;
  const siblings = devices.filter((device) => device.data?.id === vehicleId);
  const locations = siblings.filter((device) => device.driverId === 'homey:app:com.tesla.car:location');
  const cars = siblings.filter((device) => device.driverId === 'homey:app:com.tesla.car:car');
  const location = locations.length === 1 ? locations[0] : undefined;
  const car = cars.length === 1 ? cars[0] : undefined;
  if (!location || !car || !isStationaryOnlineCar(car)) return undefined;
  const coordinateAtMs = readHomeLocationEvidence(location, home);
  if (coordinateAtMs === undefined) return undefined;
  return { identity: { vehicleId, locationId: location.id, carId: car.id }, coordinateAtMs };
}
