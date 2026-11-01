import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { getLogger } from '../logging/logger';

const debugLogger = getLogger('devices/debug-dump');

/** The settings UI's "Log device" answer: whether the dump was written, and why not. */
export type DeviceDumpReply =
  | { ok: true }
  | { ok: false; error: 'INVALID_DEVICE_ID' | 'DEVICE_NOT_FOUND' };

/**
 * Answer the settings UI's request to write one Homey device's dump to the
 * log. The request body crosses the Homey API bridge, so the device id is
 * validated here; `dumpDevice` writes the dump and says whether Homey listed
 * the device.
 */
export const answerDeviceDumpRequest = async (
  body: unknown,
  dumpDevice: (deviceId: string) => Promise<boolean>,
): Promise<DeviceDumpReply> => {
  const id = isUnknownRecord(body) && typeof body.id === 'string' ? body.id.trim() : '';
  if (id === '') {
    debugLogger.warn({ event: 'homey_device_dump_invalid_request' });
    return { ok: false, error: 'INVALID_DEVICE_ID' };
  }
  return await dumpDevice(id) ? { ok: true } : { ok: false, error: 'DEVICE_NOT_FOUND' };
};
