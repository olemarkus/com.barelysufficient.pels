import { disableUnsupportedDevices } from '../lib/app/appDeviceSupport';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  PRICE_OPTIMIZATION_SETTINGS,
} from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../lib/utils/types';

const makeSettings = (initial: Record<string, unknown>) => {
  const store: Record<string, unknown> = { ...initial };
  return {
    get: jest.fn((key: string) => store[key]),
    set: jest.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
  };
};

const buildPriceOnlyDevice = (): TargetDeviceSnapshot => ({
  id: 'vt-1',
  name: 'VThermo',
  deviceType: 'temperature',
  powerCapable: false,
  targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
});

const buildFullyUnsupportedDevice = (): TargetDeviceSnapshot => ({
  id: 'socket-1',
  name: 'Garage Socket',
  deviceType: 'onoff',
  powerCapable: false,
  targets: [],
});

describe('disableUnsupportedDevices', () => {
  it('does not emit price-only log when settings are already aligned', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'vt-1': false },
      [CONTROLLABLE_DEVICES]: { 'vt-1': false },
      [PRICE_OPTIMIZATION_SETTINGS]: {
        'vt-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
      },
    });
    const logDebug = jest.fn();

    disableUnsupportedDevices({
      snapshot: [buildPriceOnlyDevice()],
      settings: settings as any,
      logDebug,
    });

    expect(settings.set).not.toHaveBeenCalled();
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('emits price-only log when unsupported settings are adjusted', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'vt-1': true },
      [CONTROLLABLE_DEVICES]: { 'vt-1': true },
      [PRICE_OPTIMIZATION_SETTINGS]: {
        'vt-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
      },
    });
    const logDebug = jest.fn();

    disableUnsupportedDevices({
      snapshot: [buildPriceOnlyDevice()],
      settings: settings as any,
      logDebug,
    });

    expect(settings.set).toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith('Disabled unsupported PELS controls: VThermo');
    expect(logDebug).toHaveBeenCalledWith(
      'Price-only support enabled (capacity disabled) for no-power temperature devices: VThermo',
    );
  });

  it('does not emit price-only log when only fully unsupported devices changed', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'vt-1': false, 'socket-1': true },
      [CONTROLLABLE_DEVICES]: { 'vt-1': false, 'socket-1': true },
      [PRICE_OPTIMIZATION_SETTINGS]: {
        'vt-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
        'socket-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
      },
    });
    const logDebug = jest.fn();

    disableUnsupportedDevices({
      snapshot: [buildPriceOnlyDevice(), buildFullyUnsupportedDevice()],
      settings: settings as any,
      logDebug,
    });

    expect(logDebug).toHaveBeenCalledWith('Disabled unsupported PELS controls: VThermo, Garage Socket');
    expect(logDebug.mock.calls.flat().some(
      (entry) => typeof entry === 'string' && entry.includes('Price-only support enabled'),
    )).toBe(false);
  });
});
