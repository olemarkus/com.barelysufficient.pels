import type { PelsHost } from './pelsHost';

/** Validate the debug request before invoking the existing dump operation. */
export async function logHomeyDeviceRequest(
  host: PelsHost | null,
  body: unknown,
  logDevice: (host: PelsHost, deviceId: string) => Promise<boolean>,
): Promise<{ ok: boolean; error?: string }> {
  if (host === null) return { ok: false, error: 'LOGGING_NOT_AVAILABLE' };
  const deviceId = body !== null && typeof body === 'object' && 'id' in body && typeof body.id === 'string'
    ? body.id.trim() : '';
  if (!deviceId) {
    host.error('Homey device log API called without valid device id');
    return { ok: false, error: 'INVALID_DEVICE_ID' };
  }
  return await logDevice(host, deviceId) ? { ok: true } : { ok: false, error: 'DEVICE_NOT_FOUND' };
}
