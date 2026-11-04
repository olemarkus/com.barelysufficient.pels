// The settings UI's key removal: a battery PELS drives with the owner's Homey
// API key is handed back before the key goes, and a refusal keeps the key and
// says why.
import { HOMEY_API_KEY_HOLDS_BATTERY_MESSAGE, chargingControlRoutes } from '../../setup/api/chargingControlRoutes';
import type { ApiContext } from '../../setup/api/defineRoutes';

const buildHomey = (removal: 'removed' | 'battery_held') => {
  const order: string[] = [];
  const access = {
    remove: vi.fn(() => { order.push('key_removed'); }),
    status: vi.fn(() => ({ configured: false, state: 'not_configured' as const })),
  };
  const batteryControl = {
    handBackBeforeHomeyApiKeyRemoval: vi.fn(async (removeKey: () => void) => {
      order.push('hand_back');
      if (removal === 'removed') removeKey();
      return removal;
    }),
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const app = { deviceManager: { chargingAccess: access }, batteryControl, getApiStructuredLogger: () => logger };
  return { homey: { app } as unknown as ApiContext['homey'], access, order };
};

describe('ui_charging_access_remove', () => {
  it('removes the key only after the batteries PELS drives with it are handed back', async () => {
    const { homey, access, order } = buildHomey('removed');

    await expect(chargingControlRoutes.ui_charging_access_remove({ homey }))
      .resolves.toEqual({ configured: false, state: 'not_configured' });

    expect(order).toEqual(['hand_back', 'key_removed']);
    expect(access.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps the key and says why while a battery is still held', async () => {
    const { homey, access } = buildHomey('battery_held');

    await expect(chargingControlRoutes.ui_charging_access_remove({ homey }))
      .rejects.toThrow(HOMEY_API_KEY_HOLDS_BATTERY_MESSAGE);

    expect(access.remove).not.toHaveBeenCalled();
  });
});
