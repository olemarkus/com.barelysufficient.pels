import type Homey from 'homey';
import { mockHomeyInstance } from '../mocks/homey';
import type { FlowBackedDeviceState } from '../../lib/device/flowBackedDeviceState';
import { createFlowBackedDeviceState } from '../../setup/flowBackedCardAccess';
import { SettingsRepository } from '../../setup/settingsRepository';
import { DEVICE_EXPECTED_POWER_OVERRIDES } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { ExpectedPowerOverridesByDeviceId } from '../../lib/device/devicePowerPeak';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

/**
 * The owner's manual expected-power figure, from `setExpectedOverride` to
 * settings. Only the Homey settings store is faked — everything the write path
 * consults is real.
 */
describe('expected power override persistence', () => {
  let overrides: ExpectedPowerOverridesByDeviceId;
  let timers: TimerRegistry;

  const buildFlowBacked = (
    homey: Homey.App['homey'] = mockHomeyInstance as unknown as Homey.App['homey'],
  ): FlowBackedDeviceState => createFlowBackedDeviceState(homey, {
    persistence: new SettingsRepository(homey),
    getStructuredLogger: () => undefined,
    getFlowReportedCapabilities: () => ({}),
    setFlowReportedCapabilities: () => {},
    getDeviceManager: () => undefined,
    getLatestTargetSnapshot: () => [],
    resolveManagedState: () => true,
    getSnapshotDevice: () => undefined,
    hasEnabledEvBoostForSnapshot: () => false,
    getSteppedLoadProfile: () => undefined,
    getExpectedPowerKwOverrides: () => overrides,
    getLearnedPowerPeaks: () => ({}),
    timers,
    syncHeadroomUsageObservation: () => {},
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('unrelated_key', true);
    timers = new TimerRegistry();
    overrides = {};
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  it('persists the figure the owner typed', () => {
    const flowBacked = buildFlowBacked();
    flowBacked.loadPersistedState();

    expect(flowBacked.setExpectedOverride('heater', 2.4)).toBe(true);

    expect(mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES))
      .toEqual({ heater: { kw: 2.4, ts: NOW } });
  });

  it('lets a retry of the same figure through when the first write threw', () => {
    // The in-memory record was mutated regardless of the write, so the equality
    // return then reported "unchanged" for a figure that never reached settings
    // — the owner could retype it forever with no effect.
    let failWrite = true;
    const flakyHomey = {
      settings: {
        get: (key: string) => mockHomeyInstance.settings.get(key),
        getKeys: () => mockHomeyInstance.settings.getKeys(),
        set: (key: string, value: unknown) => {
          if (failWrite && key === DEVICE_EXPECTED_POWER_OVERRIDES) throw new Error('transient write failure');
          mockHomeyInstance.settings.set(key, value);
        },
      },
      flow: {},
    } as unknown as Homey.App['homey'];
    const flowBacked = buildFlowBacked(flakyHomey);
    flowBacked.loadPersistedState();

    expect(flowBacked.setExpectedOverride('heater', 2.4)).toBe(true);
    expect(mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES)).toBeNull();

    failWrite = false;
    expect(flowBacked.setExpectedOverride('heater', 2.4)).toBe(true);
    expect(mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES))
      .toEqual({ heater: { kw: 2.4, ts: NOW } });
  });

  it('still reports an unchanged figure as unchanged once it is persisted', () => {
    const flowBacked = buildFlowBacked();
    flowBacked.loadPersistedState();

    expect(flowBacked.setExpectedOverride('heater', 2.4)).toBe(true);
    expect(flowBacked.setExpectedOverride('heater', 2.4)).toBe(false);
  });

  it('refuses to write over figures the boot read could not see', () => {
    mockHomeyInstance.settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, { heater: { kw: 2.4, ts: NOW - 1000 } });
    let readable = false;
    const flakyHomey = {
      settings: {
        get: (key: string) => {
          if (!readable && key === DEVICE_EXPECTED_POWER_OVERRIDES) throw new Error('transient read failure');
          return mockHomeyInstance.settings.get(key);
        },
        getKeys: () => mockHomeyInstance.settings.getKeys(),
        set: (key: string, value: unknown) => mockHomeyInstance.settings.set(key, value),
      },
      flow: {},
    } as unknown as Homey.App['homey'];
    const flowBacked = buildFlowBacked(flakyHomey);
    flowBacked.loadPersistedState();

    flowBacked.setExpectedOverride('charger', 7);
    expect(mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES))
      .toEqual({ heater: { kw: 2.4, ts: NOW - 1000 } });

    // Once the key reads again, the retry keeps both: the heater figure the
    // owner typed on an earlier run and the charger figure typed on this one.
    readable = true;
    flowBacked.setExpectedOverride('charger', 7);
    expect(mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES)).toEqual({
      heater: { kw: 2.4, ts: NOW - 1000 },
      charger: { kw: 7, ts: NOW },
    });
  });
});
