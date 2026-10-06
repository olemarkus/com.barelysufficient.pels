import { BATTERY_CONTROL_DEVICES } from '../../contracts/src/settingsKeys.ts';
// A battery's Managed toggle writes the whole `battery_control_devices` map
// from a fresh read. Two toggles in quick succession (two batteries, or the
// device list and the device page) must both land: each write runs after the
// previous one, never interleaved with it.

const store = new Map<string, unknown>();
vi.mock('../src/ui/homey.ts', () => ({
  getSettingFresh: async (key: string) => {
    // A slow bridge read: without serialization both writes read the same map.
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    return store.get(key);
  },
  setSetting: async (key: string, value: unknown) => { store.set(key, value); },
  callApi: vi.fn(),
  invalidateApiCache: vi.fn(),
}));
vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));

const { writeBatteryManaged } = await import('../src/ui/batteryManaged.ts');
const { state } = await import('../src/ui/state.ts');

describe('battery Managed writes', () => {
  beforeEach(() => {
    store.clear();
    state.batteryControl = { status: 'resolved', devices: {} };
    state.latestDevices = [];
  });

  it('lands two quick toggles on different batteries', async () => {
    const noop = () => undefined;
    await Promise.all([
      writeBatteryManaged('battery-1', false, 'device list', noop, noop),
      writeBatteryManaged('battery-2', false, 'device detail', noop, noop),
    ]);
    expect(store.get(BATTERY_CONTROL_DEVICES)).toEqual({ 'battery-1': false, 'battery-2': false });
  });

  it('clears the takeover notice when the owner turns Managed back on', async () => {
    state.latestDevices = [
      { id: 'battery-1', name: 'Battery', deviceClass: 'battery', batteryTakenOver: true },
    ] as unknown as typeof state.latestDevices;
    await writeBatteryManaged('battery-1', true, 'device detail', () => undefined, () => undefined);
    expect(state.latestDevices[0]?.batteryTakenOver).toBeUndefined();
  });
});
