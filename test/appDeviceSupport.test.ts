import {
  disableUnsupportedDevices,
  isManagedFilterActive,
  seedMissingModeTargets,
  __resetSeedSkipDedupeForTests,
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

describe('seedMissingModeTargets', () => {
  beforeEach(() => {
    __resetSeedSkipDedupeForTests();
  });

  const buildThermostat = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
    id: 't-1',
    name: 'Stue',
    deviceType: 'temperature',
    powerCapable: true,
    targets: [{ id: 'target_temperature', value: 21, unit: '°C', min: 5, max: 35, step: 0.5 }],
    ...overrides,
  });

  const baseSettings = (modeTargets: Record<string, Record<string, number>>) => makeSettings({
    [MANAGED_DEVICES]: { 't-1': true },
    [CONTROLLABLE_DEVICES]: { 't-1': true },
    mode_device_targets: modeTargets,
  });

  it('seeds missing entries from the device current setpoint', () => {
    const settings = baseSettings({ Home: {}, Away: {}, Night: {} });
    const structuredLog = vi.fn();
    const logDebug = vi.fn();

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: settings as any,
      structuredLog,
      logDebug,
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21 },
      Away: { 't-1': 21 },
      Night: { 't-1': 21 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_auto_seeded',
      deviceId: 't-1',
      seededModes: ['Home', 'Away', 'Night'],
      seededValue: 21,
      source: 'device_setpoint',
    }));
  });

  it('is a no-op when every entry is already populated', () => {
    const settings = baseSettings({ Home: { 't-1': 19 }, Away: { 't-1': 17 } });

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: settings as any,
      structuredLog: vi.fn(),
      logDebug: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('only seeds the missing modes, leaving existing entries intact', () => {
    const settings = baseSettings({ Home: { 't-1': 19 }, Away: {}, Night: { 't-1': 16 } });
    const structuredLog = vi.fn();

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: settings as any,
      structuredLog,
      logDebug: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 19 },
      Away: { 't-1': 21 },
      Night: { 't-1': 16 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_auto_seeded',
      seededModes: ['Away'],
    }));
  });

  it('normalizes the seed value through the target capability bounds and step', () => {
    const settings = baseSettings({ Home: {} });
    // Capability step=0.5, min=5, max=35; raw current 21.34 should snap to 21.5
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: 21.34, unit: '°C', min: 5, max: 35, step: 0.5 }],
    });

    seedMissingModeTargets({
      snapshot: [thermostat],
      settings: settings as any,
      structuredLog: vi.fn(),
      logDebug: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21.5 },
    });
  });

  it('skips devices that lack a finite current setpoint and emits skip events', () => {
    const settings = baseSettings({ Home: {}, Away: {} });
    const structuredLog = vi.fn();
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: Number.NaN, unit: '°C' }],
    });

    seedMissingModeTargets({
      snapshot: [thermostat],
      settings: settings as any,
      structuredLog,
      logDebug: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_seed_skipped',
      deviceId: 't-1',
      reason: 'no_seed_source',
      mode: 'Home',
    }));
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'Away',
      reason: 'no_seed_source',
    }));
  });

  it('ignores non-temperature, non-managed, non-controllable, and no-target devices', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-managed': true, 't-unmanaged': false, 't-uncontrollable': true },
      [CONTROLLABLE_DEVICES]: { 't-managed': true, 't-unmanaged': true, 't-uncontrollable': false },
      mode_device_targets: { Home: {} },
    });

    seedMissingModeTargets({
      snapshot: [
        buildThermostat({ id: 't-unmanaged' }),
        buildThermostat({ id: 't-uncontrollable' }),
        buildThermostat({ id: 't-notemp', deviceType: 'onoff' }),
        buildThermostat({ id: 't-notargets', targets: [] }),
      ],
      settings: settings as any,
      structuredLog: vi.fn(),
      logDebug: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('does nothing when no modes are configured', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      [CONTROLLABLE_DEVICES]: { 't-1': true },
      mode_device_targets: {},
    });

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: settings as any,
      structuredLog: vi.fn(),
      logDebug: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('does nothing when mode_device_targets is missing or malformed', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      [CONTROLLABLE_DEVICES]: { 't-1': true },
    });

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: settings as any,
      structuredLog: vi.fn(),
      logDebug: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('preserves mode keys whose stored value is null/primitive and seeds them', () => {
    // Mimic corrupted settings where a mode key exists but its value is not a
    // plain object (e.g. legacy/import path wrote `null`). Dropping the mode
    // would silently lose user configuration on the next write.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      [CONTROLLABLE_DEVICES]: { 't-1': true },
      mode_device_targets: { Home: { 't-1': 19 }, Borte: null, Natt: 'oops' },
    });

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: settings as any,
      structuredLog: vi.fn(),
      logDebug: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 19 },
      Borte: { 't-1': 21 },
      Natt: { 't-1': 21 },
    });
  });

  it('does not re-seed an entry the user cleared after we already seeded it', () => {
    // Race regression: the snapshot refresh used to re-seed any missing
    // (mode, device) entry. If the user cleared an auto-seeded entry from
    // the settings UI between refreshes, the next cycle would silently put
    // it back. Edge-trigger the seeder per (mode, deviceId) so a user-clear
    // sticks within the session.
    const initial = baseSettings({ Home: {}, Away: {} });
    const structuredLog = vi.fn();

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: initial as any,
      structuredLog,
      logDebug: vi.fn(),
    });
    expect(initial.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21 },
      Away: { 't-1': 21 },
    });

    // Simulate a user-clear of the Home entry between snapshot refreshes:
    // the entry is now missing again but we've already seeded it once.
    const afterClear = baseSettings({ Home: {}, Away: { 't-1': 21 } });
    structuredLog.mockClear();

    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: afterClear as any,
      structuredLog,
      logDebug: vi.fn(),
    });

    expect(afterClear.set).not.toHaveBeenCalled();
    expect(structuredLog).not.toHaveBeenCalled();
  });

  it('seeds a freshly added device whose entries have never been seeded', () => {
    // Positive case alongside the user-clear regression: a brand-new device
    // appearing mid-session (no prior fingerprint) must still be seeded on
    // the next snapshot refresh. Ensures the dedupe is keyed per device, not
    // applied process-wide.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true, 't-new': true },
      [CONTROLLABLE_DEVICES]: { 't-1': true, 't-new': true },
      mode_device_targets: { Home: {}, Away: {} },
    });
    const structuredLog = vi.fn();

    // First pass seeds the original device, recording its fingerprints.
    seedMissingModeTargets({
      snapshot: [buildThermostat()],
      settings: settings as any,
      structuredLog,
      logDebug: vi.fn(),
    });
    settings.set.mockClear();
    structuredLog.mockClear();

    // A new device appears in the snapshot — never seeded — and must be
    // seeded normally even though the prior device's fingerprints exist.
    seedMissingModeTargets({
      snapshot: [
        buildThermostat(),
        buildThermostat({ id: 't-new', name: 'Bad', targets: [
          { id: 'target_temperature', value: 19, unit: '°C', min: 5, max: 35, step: 0.5 },
        ] }),
      ],
      settings: settings as any,
      structuredLog,
      logDebug: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21, 't-new': 19 },
      Away: { 't-1': 21, 't-new': 19 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_auto_seeded',
      deviceId: 't-new',
      seededModes: ['Home', 'Away'],
      seededValue: 19,
    }));
  });

  it('emits each seed_skipped event only once per (device, mode, reason) across cycles', () => {
    const settings = baseSettings({ Home: {}, Away: {} });
    const structuredLog = vi.fn();
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: Number.NaN, unit: '°C' }],
    });

    seedMissingModeTargets({
      snapshot: [thermostat],
      settings: settings as any,
      structuredLog,
      logDebug: vi.fn(),
    });
    seedMissingModeTargets({
      snapshot: [thermostat],
      settings: settings as any,
      structuredLog,
      logDebug: vi.fn(),
    });

    const skippedEvents = structuredLog.mock.calls
      .map(([event]) => event)
      .filter((event: any) => event.event === 'mode_target_seed_skipped');
    expect(skippedEvents).toHaveLength(2);
    expect(skippedEvents.map((e: any) => e.mode).sort()).toEqual(['Away', 'Home']);
  });
});
