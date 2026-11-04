import { resolveTargetPowerLadderIssue } from '../../shared-domain/src/targetPowerLadder.ts';
import {
  DEVICE_CONTROL_PROFILES, DEVICE_TARGET_POWER_CONFIGS, DEVICE_POWER_CONTROL_MODES,
} from '../../shared-domain/src/settings/settingsKeys.ts';
const { getSetting } = vi.hoisted(() => ({ getSetting: vi.fn() }));

let loadDeviceControlProfiles: typeof import('../src/ui/deviceControlProfiles.ts').loadDeviceControlProfiles;
let normalizeTargetPowerConfig: typeof import('../src/ui/deviceControlProfiles.ts').normalizeTargetPowerConfig;
let createContinuousTargetPowerConfig: typeof import('../src/ui/deviceDetail/targetPowerConfig.ts')
  .createContinuousTargetPowerConfig;
let state: typeof import('../src/ui/state.ts').state;

vi.mock('../src/ui/homey.ts', async () => ({
  ...await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts'),
  getSetting,
}));
vi.mock('../src/ui/logging.ts', async () => ({
  ...await vi.importActual<typeof import('../src/ui/logging.ts')>('../src/ui/logging.ts'),
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  vi.resetModules();
  getSetting.mockReset();
  ({ loadDeviceControlProfiles, normalizeTargetPowerConfig } = await import('../src/ui/deviceControlProfiles.ts'));
  ({ createContinuousTargetPowerConfig } = await import('../src/ui/deviceDetail/targetPowerConfig.ts'));
  ({ state } = await import('../src/ui/state.ts'));
});

describe('device control choice loading', () => {
  it.each([null, undefined])('keeps an initial %s WebView read unresolved until the saved map arrives', async (missing) => {
    let modes: unknown = missing;
    getSetting.mockImplementation(async (key) => key === DEVICE_POWER_CONTROL_MODES ? modes : {});

    await loadDeviceControlProfiles();
    expect(state.devicePowerControlModesLoaded).toBe(false);
    expect(state.devicePowerControlModes).toEqual({});

    modes = { other: 'manual', garage: 'automatic' };
    await loadDeviceControlProfiles();
    expect(state.devicePowerControlModesLoaded).toBe(true);
    expect(state.devicePowerControlModes).toEqual({ other: 'manual', garage: 'automatic' });
  });

  it('accepts an absent mode map served by the authoritative bootstrap', async () => {
    const { applyBootstrapSettings } = await import('../src/ui/homey.ts');
    applyBootstrapSettings({ [DEVICE_POWER_CONTROL_MODES]: null });
    getSetting.mockImplementation(async (key) => key === DEVICE_POWER_CONTROL_MODES ? null : {});

    await loadDeviceControlProfiles();

    expect(state.devicePowerControlModesLoaded).toBe(true);
    expect(state.devicePowerControlModes).toEqual({});
  });

  it('retains an accepted empty map through a failed read followed by a missing read', async () => {
    let modes: unknown = {};
    getSetting.mockImplementation(async (key) => key === DEVICE_POWER_CONTROL_MODES ? modes : {});
    await loadDeviceControlProfiles();
    const acceptedModes = state.devicePowerControlModes;

    modes = { garage: 'invalid' };
    await loadDeviceControlProfiles();
    expect(state.devicePowerControlModesLoaded).toBe(false);

    modes = null;
    await loadDeviceControlProfiles();
    expect(state.devicePowerControlModesLoaded).toBe(true);
    expect(state.devicePowerControlModes).toBe(acceptedModes);
  });

  it.each([null, undefined])('retains choices on a %s read and accepts an explicit empty map', async (missing) => {
    let modes: unknown = { garage: 'manual', driveway: 'automatic' };
    vi.mocked(getSetting).mockImplementation(async (key) => (
      key === DEVICE_POWER_CONTROL_MODES ? modes : {}
    ));
    await loadDeviceControlProfiles();
    const acceptedModes = state.devicePowerControlModes;

    modes = missing;
    await loadDeviceControlProfiles();
    expect(state.devicePowerControlModes).toBe(acceptedModes);
    expect(state.devicePowerControlModes).toEqual({ garage: 'manual', driveway: 'automatic' });
    expect(state.devicePowerControlModesLoaded).toBe(true);

    modes = {};
    await loadDeviceControlProfiles();
    expect(state.devicePowerControlModes).toEqual({});
    expect(state.devicePowerControlModesLoaded).toBe(true);
  });

  it.each(['thrown', 'malformed'] as const)(
    'preserves accepted Manual configuration and mode choices after a %s mode read, then retries', async (failure) => {
      const profiles = {
        garage: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'gentle', planningPowerW: 1800 }] },
        tank: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 3000 }] },
      };
      const configs = {
        garage: { enabled: true, preset: 'ev_charger_3_phase' as const, max: 7360 },
        tank: { enabled: true, min: 0, max: 3000, step: 500 },
      };
      let failModeRead = false;
      vi.mocked(getSetting).mockImplementation(async (key) => {
        if (key === DEVICE_CONTROL_PROFILES) return profiles;
        if (key === DEVICE_TARGET_POWER_CONFIGS) return configs;
        if (key === DEVICE_POWER_CONTROL_MODES) {
          if (!failModeRead) return { garage: 'manual', driveway: 'automatic' };
          if (failure === 'thrown') throw new Error('Homey read unavailable');
          return { garage: 'unsupported' };
        }
        throw new Error(`Unexpected setting: ${key}`);
      });
      await loadDeviceControlProfiles();
      const acceptedModes = state.devicePowerControlModes;
      expect(state.devicePowerControlModesLoaded).toBe(true);

      failModeRead = true;
      await loadDeviceControlProfiles();

      expect(state.deviceControlProfiles).toEqual(profiles);
      expect(state.deviceTargetPowerConfigs).toEqual(configs);
      expect(state.devicePowerControlModes).toBe(acceptedModes);
      expect(state.devicePowerControlModes).toEqual({ garage: 'manual', driveway: 'automatic' });
      expect(state.devicePowerControlModesLoaded).toBe(false);

      failModeRead = false;
      await loadDeviceControlProfiles();
      expect(state.devicePowerControlModesLoaded).toBe(true);
      expect(state.deviceControlProfiles).toEqual(profiles);
      expect(state.deviceTargetPowerConfigs).toEqual(configs);
    },
  );
});

describe('deviceControlProfiles target-power normalization', () => {
  it('does not admit runtime-owned reachability into the editable user config', () => {
    expect(normalizeTargetPowerConfig({
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
      reachability: {
        profileFingerprint: 'ev_charger_1_phase:off=0,32a=7360',
        maxReachedPowerW: 5750,
        probeFailureCount: 1,
        nextProbeAtMs: 900_000,
      },
    })).toEqual({
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    });
  });

  it('drops malformed reachability without discarding the editable base config', () => {
    expect(normalizeTargetPowerConfig({
      enabled: true,
      preset: 'ev_charger_1_phase',
      reachability: {
        profileFingerprint: '',
        maxReachedPowerW: Number.NaN,
        probeFailureCount: -1,
      },
    })).toEqual({ enabled: true, preset: 'ev_charger_1_phase' });
  });

  it('keeps a large device inside the shared step ceiling when seeding a continuous range', () => {
    // A flat 100 W seed produced 220 rungs for a 22 kW charger, so the screen
    // handed the owner a draft its own Save (and the runtime) would reject.
    const seed = createContinuousTargetPowerConfig({
      id: 'charger', expectedPowerKw: 22,
    } as Parameters<typeof createContinuousTargetPowerConfig>[0]);

    expect(seed.max).toBe(22_000);
    expect(resolveTargetPowerLadderIssue(seed)).toBeUndefined();
    // Ordinary loads keep the familiar 100 W granularity.
    expect(createContinuousTargetPowerConfig({
      id: 'heater', expectedPowerKw: 1.5,
    } as Parameters<typeof createContinuousTargetPowerConfig>[0]).step).toBe(100);
  });

  it('drops a range that yields no step ladder, matching the runtime normalizer', () => {
    // The runtime would refuse this config too, so admitting it here would only
    // show the owner a stepped device the runtime does not agree exists.
    expect(normalizeTargetPowerConfig({ enabled: true, max: 100, step: 500 })).toBeNull();
    expect(normalizeTargetPowerConfig({ max: 3680, step: 0 })).toBeNull();
    expect(normalizeTargetPowerConfig({ min: 1380, max: 3680, step: 460 })).toBeNull();
    expect(normalizeTargetPowerConfig({ max: 3680, step: 460 }))
      .toEqual({ max: 3680, step: 460 });
  });
});
