export type Coordinates = { latitude: number; longitude: number };
export function readCoordinates(latitude: unknown, longitude: unknown): Coordinates | undefined {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return undefined;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

