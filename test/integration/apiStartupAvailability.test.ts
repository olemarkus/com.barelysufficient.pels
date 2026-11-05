import type Homey from 'homey';
import api from '../../api';
import type { DeviceTransportPort } from '../../lib/device/deviceTransport';
import { partialDouble } from '../helpers/partialDouble';
import { pelsHostDouble } from '../helpers/pelsHostDouble';

it.each(['homey_devices', 'homey_energy_meters', 'ui_price_setup_suggestion'] as const)(
  '%s rejects an absent app instead of reporting an empty home', async (route) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(api[route]({ homey: partialDouble<Homey.App['homey']>({}) }))
        .rejects.toThrow('PELS is starting. Try again shortly.');
    } finally {
      consoleError.mockRestore();
    }
  },
);

it('rejects an unwired inventory transport instead of reporting no devices', async () => {
  const host = pelsHostDouble({ deviceManager: undefined });
  await expect(api.homey_devices({ homey: partialDouble<Homey.App['homey']>({ app: partialDouble<Homey.App>(host) }) }))
    .rejects.toThrow('DeviceTransport must be initialized before use.');
});

it('preserves a genuinely empty inventory after the transport is available', async () => {
  const host = pelsHostDouble({ deviceManager: partialDouble<DeviceTransportPort>({
    getDevicesForDebug: async () => [],
    getZoneTree: () => null,
  }) });
  await expect(api.homey_devices({ homey: partialDouble<Homey.App['homey']>({ app: partialDouble<Homey.App>(host) }) }))
    .resolves.toEqual([]);
});

it('preserves a genuine no-suggestion answer', async () => {
  const suggestion = { gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' } } as const;
  const host = pelsHostDouble({ suggestPriceSetup: async () => suggestion });
  await expect(api.ui_price_setup_suggestion({ homey: partialDouble<Homey.App['homey']>({ app: partialDouble<Homey.App>(host) }) }))
    .resolves.toEqual(suggestion);
});
