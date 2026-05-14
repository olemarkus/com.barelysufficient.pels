import {
  disableUnsupportedDevices,
  isManagedFilterActive,
} from '../lib/app/appDeviceSupport';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  PRICE_OPTIMIZATION_SETTINGS,
} from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../lib/utils/types';

const makeSettings = (initial: Record<string, unknown>) => {
  const store: Record<string, unknown> = { ...initial };
  return {
    get: vi.fn((key: string) => store[key]),
    set: vi.fn((key: string, value: unknown) => {
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
    const logDebug = vi.fn();

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
    const logDebug = vi.fn();

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
    const logDebug = vi.fn();

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

  it('does not write managed/controllable settings when unsupported IDs were never user-managed', () => {
    // Fresh-install scenario: managedDevices map is empty; an unsupported
    // device shows up. Writing { id: false } would fire the settings handler
    // and trigger a recursive snapshot refresh on first boot.
    const settings = makeSettings({});
    const logDebug = vi.fn();

    disableUnsupportedDevices({
      snapshot: [buildFullyUnsupportedDevice()],
      settings: settings as any,
      logDebug,
    });

    expect(settings.set).not.toHaveBeenCalled();
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('does not re-emit the price-only log on repeated refreshes for fresh-install price-only devices', () => {
    // Regression: when `controllable_devices[id]` is absent (fresh install),
    // the demotion path correctly skips the no-op write — but the
    // `changedPriceOnly` log must still be edge-triggered. Otherwise the
    // "Price-only support enabled..." line fires on every snapshot refresh,
    // creating persistent operational log noise.
    const settings = makeSettings({});
    const logDebug = vi.fn();

    disableUnsupportedDevices({
      snapshot: [buildPriceOnlyDevice()],
      settings: settings as any,
      logDebug,
    });
    expect(logDebug.mock.calls.flat().some(
      (entry) => typeof entry === 'string' && entry.includes('Price-only support enabled'),
    )).toBe(false);

    // Second refresh with the same (still-absent) settings: still no log.
    logDebug.mockClear();
    disableUnsupportedDevices({
      snapshot: [buildPriceOnlyDevice()],
      settings: settings as any,
      logDebug,
    });
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('writes managed/controllable false only when the user previously enabled the device', () => {
    // EV-by-default migration set { ev1: true }; the device turns out to be
    // unsupported. We must demote it to false. After that demotion, the next
    // refresh sees the false key and produces no further writes.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'ev1': true, 'socket-1': true },
      [CONTROLLABLE_DEVICES]: { 'ev1': true, 'socket-1': true },
    });
    const logDebug = vi.fn();
    const evDevice: TargetDeviceSnapshot = {
      id: 'ev1',
      name: 'EV Charger',
      deviceType: 'onoff',
      powerCapable: false,
      targets: [],
    };

    disableUnsupportedDevices({
      snapshot: [evDevice],
      settings: settings as any,
      logDebug,
    });

    const writtenManaged = settings.set.mock.calls.find(([key]) => key === MANAGED_DEVICES)?.[1];
    const writtenControllable = settings.set.mock.calls.find(([key]) => key === CONTROLLABLE_DEVICES)?.[1];
    expect(writtenManaged).toEqual({ 'ev1': false, 'socket-1': true });
    expect(writtenControllable).toEqual({ 'ev1': false, 'socket-1': true });

    // Idempotence: a second pass with the new (post-demote) settings produces
    // no further writes — the recursive refresh therefore terminates after at
    // most one extra cycle.
    settings.set.mockClear();
    disableUnsupportedDevices({
      snapshot: [evDevice],
      settings: settings as any,
      logDebug,
    });
    expect(settings.set).not.toHaveBeenCalled();
  });
});

describe('isManagedFilterActive', () => {
  it('reports inactive for an empty managed map', () => {
    expect(isManagedFilterActive({})).toBe(false);
  });

  it('reports inactive for an all-false managed map', () => {
    // Critical regression: `disableUnsupportedDevices` writes `{id: false}`
    // entries on first boot. The filter must NOT activate from those writes —
    // otherwise implicitly-managed (no-key) devices would suddenly disappear
    // from the runtime snapshot mid-cycle.
    expect(isManagedFilterActive({ 'vt-1': false, 'socket-1': false })).toBe(false);
  });

  it('reports active when at least one device is explicitly enabled', () => {
    expect(isManagedFilterActive({ 'ev1': true })).toBe(true);
    expect(isManagedFilterActive({ 'ev1': true, 'vt-1': false })).toBe(true);
  });
});
