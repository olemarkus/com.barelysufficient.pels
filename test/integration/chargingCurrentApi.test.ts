import type Homey from 'homey';
import api from '../../api';
import type { DeviceTransportPort } from '../../lib/device/deviceTransport';
import type { ChargingCurrentControl } from '../../lib/device/chargingCurrentControl';
import type { Logger } from '../../lib/logging/logger';
import { partialDouble } from '../helpers/partialDouble';
import { pelsHostDouble } from '../helpers/pelsHostDouble';

function fixture() {
  const save = vi.fn<ChargingCurrentControl['save']>().mockResolvedValue(undefined);
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const warn = vi.fn();
  const error = vi.fn();
  const host = pelsHostDouble({
    deviceManager: partialDouble<DeviceTransportPort>({
      chargingCurrentControl: partialDouble<ChargingCurrentControl>({ save }),
    }),
    refreshTargetDevicesSnapshot: refresh,
    getApiStructuredLogger: () => partialDouble<Logger>({ warn, error }),
  });
  const homey = { app: host } as unknown as Homey.App['homey'];
  const context = { homey, params: { deviceId: 'charger' },
    body: { method: 'built_in', confirmation: 'single_charger' } };
  return { context, save, refresh, warn, error };
}

test('a committed current-route save succeeds when its snapshot refresh fails', async () => {
  const { context, save, refresh, warn, error } = fixture();
  const failure = new Error('Homey snapshot unavailable');
  refresh.mockRejectedValue(failure);
  await expect(api.ui_charging_current_save(context)).resolves.toBeUndefined();
  expect(save).toHaveBeenCalledExactlyOnceWith('charger', context.body);
  expect(warn).toHaveBeenCalledExactlyOnceWith({
    event: 'charging_control_snapshot_refresh_failed', deviceId: 'charger', err: failure,
  });
  expect(error).not.toHaveBeenCalled();
});

test('a failed current-route save still rejects and does not refresh the snapshot', async () => {
  const { context, save, refresh, warn, error } = fixture();
  const failure = new Error('Settings write failed');
  save.mockRejectedValue(failure);
  await expect(api.ui_charging_current_save(context)).rejects.toBe(failure);
  expect(refresh).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'api_handler_failed', err: failure }));
});
