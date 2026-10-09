import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import {
  ModeDeviceTargetFill,
  type ModeTargetFillDevice,
} from '../../lib/home/modeDeviceTargetFill';
import {
  MAIN_HOME_ID,
  MODE_DEVICE_TARGETS,
  homeScopedSettingsKey,
  type HomeId,
} from '../../lib/utils/settingsKeys';
import { partialDouble } from '../helpers/partialDouble';

const makeSettings = (initial: Record<string, unknown>) => {
  const store: Record<string, unknown> = { ...initial };
  return {
    get: vi.fn((key: string): unknown => store[key]),
    // The real SDK exposes the key list, and the fill uses it to tell a
    // never-written catalog from a transiently-empty read.
    getKeys: vi.fn(() => Object.keys(store)),
    set: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
  };
};

type SettingsDouble = ReturnType<typeof makeSettings>;

const asSettingsPort = (settings: SettingsDouble): SettingsPort => partialDouble<SettingsPort>(settings);

const thermostat: ModeTargetFillDevice = { id: 't-1', name: 'Stue', heldSetpointC: 21 };

// One instance per test, as production builds one per app: what it already
// filled lives on the instance.
const createFill = (
  settings: SettingsDouble,
  listDevices: () => readonly ModeTargetFillDevice[] = () => [thermostat],
  resolveHomeIdForDevice: (deviceId: string) => HomeId | null = () => MAIN_HOME_ID,
) => {
  const structuredLog = vi.fn();
  const fill = new ModeDeviceTargetFill(asSettingsPort(settings), listDevices, resolveHomeIdForDevice, structuredLog);
  return { fill, structuredLog };
};

describe('ModeDeviceTargetFill', () => {
  it('fills missing entries in every mode from the held setpoint', () => {
    const settings = makeSettings({ mode_device_targets: { Home: {}, Away: {}, Night: {} } });
    const { fill, structuredLog } = createFill(settings);

    fill.persist();

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21 },
      Away: { 't-1': 21 },
      Night: { 't-1': 21 },
    });
    expect(structuredLog).toHaveBeenCalledWith({
      event: 'mode_target_filled',
      deviceId: 't-1',
      deviceName: 'Stue',
      filledModes: ['Home', 'Away', 'Night'],
      targetC: 21,
    });
  });

  it('is a no-op when every entry is already populated', () => {
    const settings = makeSettings({ mode_device_targets: { Home: { 't-1': 19 }, Away: { 't-1': 17 } } });

    createFill(settings).fill.persist();

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('is a no-op when no device holds a setpoint', () => {
    const settings = makeSettings({ mode_device_targets: { Home: {} } });

    createFill(settings, () => []).fill.persist();

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('only fills the missing modes, leaving existing entries intact', () => {
    const settings = makeSettings({ mode_device_targets: { Home: { 't-1': 19 }, Away: {}, Night: { 't-1': 16 } } });
    const { fill, structuredLog } = createFill(settings);

    fill.persist();

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 19 },
      Away: { 't-1': 21 },
      Night: { 't-1': 16 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_filled',
      filledModes: ['Away'],
    }));
  });

  it('creates the default mode when the catalog has never been written', () => {
    // Main's `mode_device_targets` is only ever written by the settings UI, so
    // an owner who never opened the Modes screen had NO mode targets at all —
    // while the planner still planned their heaters and auto-assigned them a
    // setpoint shed. There has to be a mode to fill against. Another key is
    // stored, so the key list reads as a real install's.
    const settings = makeSettings({ operating_mode: 'Home' });

    createFill(settings).fill.persist();

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
  });

  it('creates the default mode when the stored catalog is an empty object', () => {
    const settings = makeSettings({ mode_device_targets: {} });

    createFill(settings).fill.persist();

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
  });

  it('writes nothing when the catalog read cannot be trusted', () => {
    // The next act is a whole-blob `set`. A malformed payload, a thrown read,
    // and an empty key list are all states where one transient SDK miss would
    // otherwise become a wipe — decide nothing and retry next refresh.
    const malformed = makeSettings({ mode_device_targets: ['not', 'a', 'catalog'] });
    const emptyKeyList = makeSettings({ operating_mode: 'Home' });
    emptyKeyList.getKeys.mockReturnValue([]);
    const throwingRead = makeSettings({ operating_mode: 'Home' });
    throwingRead.get.mockImplementation((key: string) => {
      if (key === 'mode_device_targets') throw new Error('boom');
      return undefined;
    });

    [malformed, emptyKeyList, throwingRead].forEach((settings) => {
      createFill(settings).fill.persist();

      expect(settings.set).not.toHaveBeenCalled();
    });
  });

  it('preserves mode keys whose stored value is null/primitive and fills them', () => {
    // Mimic corrupted settings where a mode key exists but its value is not a
    // plain object (e.g. legacy/import path wrote `null`). Dropping the mode
    // would silently lose user configuration on the next write.
    const settings = makeSettings({ mode_device_targets: { Home: { 't-1': 19 }, Borte: null, Natt: 'oops' } });

    createFill(settings).fill.persist();

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 19 },
      Borte: { 't-1': 21 },
      Natt: { 't-1': 21 },
    });
  });

  it('does not re-fill an entry the user cleared after this instance filled it', () => {
    // Race regression: the snapshot refresh used to re-fill any missing
    // (mode, device) entry. If the user cleared an auto-filled entry from the
    // settings UI between refreshes, the next cycle would silently put it back.
    // Edge-trigger the fill per (home, mode, device) so a user-clear sticks for
    // the life of the instance.
    const settings = makeSettings({ mode_device_targets: { Home: {}, Away: {} } });
    const { fill, structuredLog } = createFill(settings);

    fill.persist();
    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21 },
      Away: { 't-1': 21 },
    });

    // A user-clear of the Home entry between snapshot refreshes: the entry is
    // missing again, but this instance already filled it once.
    settings.set('mode_device_targets', { Home: {}, Away: { 't-1': 21 } });
    settings.set.mockClear();
    structuredLog.mockClear();

    fill.persist();

    expect(settings.set).not.toHaveBeenCalled();
    expect(structuredLog).not.toHaveBeenCalled();
  });

  it('fills the cleared entry again on a fresh instance, as after a restart', () => {
    // The record is deliberately not persisted: an entry still missing after a
    // restart is one the owner has not had a chance to clear.
    const settings = makeSettings({ mode_device_targets: { Home: {} } });
    createFill(settings).fill.persist();
    settings.set('mode_device_targets', { Home: {} });
    settings.set.mockClear();

    createFill(settings).fill.persist();

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
  });

  it('fills a freshly added device whose entries have never been filled', () => {
    // Positive case alongside the user-clear regression: a brand-new device
    // appearing mid-session (no prior fingerprint) must still be filled on the
    // next snapshot refresh. Ensures the record is keyed per device, not
    // applied process-wide.
    const settings = makeSettings({ mode_device_targets: { Home: {}, Away: {} } });
    let devices: readonly ModeTargetFillDevice[] = [thermostat];
    const { fill, structuredLog } = createFill(settings, () => devices);

    // First pass fills the original device, recording its fingerprints.
    fill.persist();
    settings.set.mockClear();
    structuredLog.mockClear();

    // A new device appears — never filled — and must be filled normally even
    // though the prior device's fingerprints exist.
    devices = [thermostat, { id: 't-new', name: 'Bad', heldSetpointC: 19 }];
    fill.persist();

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21, 't-new': 19 },
      Away: { 't-1': 21, 't-new': 19 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_filled',
      deviceId: 't-new',
      filledModes: ['Home', 'Away'],
      targetC: 19,
    }));
  });

  it('fills each device into its own home\'s catalog and skips one whose home is unsettled', () => {
    const areaKey = homeScopedSettingsKey(MODE_DEVICE_TARGETS, 'area-1');
    const settings = makeSettings({ mode_device_targets: { Home: {} }, [areaKey]: { Home: {} } });
    const homes: Record<string, HomeId | null> = { 't-1': MAIN_HOME_ID, 't-area': 'area-1', 't-pending': null };
    const { fill } = createFill(
      settings,
      () => [
        thermostat,
        { id: 't-area', name: 'Hytte', heldSetpointC: 18 },
        { id: 't-pending', name: 'Gang', heldSetpointC: 20 },
      ],
      (deviceId) => homes[deviceId] ?? null,
    );

    fill.persist();

    expect(settings.set).toHaveBeenCalledTimes(2);
    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
    expect(settings.set).toHaveBeenCalledWith(areaKey, { Home: { 't-area': 18 } });
  });
});
