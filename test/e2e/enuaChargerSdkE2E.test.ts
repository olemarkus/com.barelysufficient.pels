import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS, MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import type { TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';

const ID = 'enua';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const GRIDS = [
  { grid: '1phase', wattsPerAmp: 230 },
  { grid: 'tn_3phase', wattsPerAmp: 690 },
  { grid: 'it_3phase', wattsPerAmp: Math.sqrt(3) * 230 },
] as const;
const SAVED_CONFIGS: { mode: string; config: TargetPowerSteppedLoadConfig }[] = [
  { mode: 'one-phase preset', config: { enabled: true, preset: 'ev_charger_1_phase' } },
  { mode: 'three-phase preset', config: { enabled: true, preset: 'ev_charger_3_phase' } },
  { mode: 'legacy continuous range', config: { enabled: true, min: 0, max: 22080, step: 230 } },
];

function planningWattsPerAmp(config: TargetPowerSteppedLoadConfig, gridWatts: number): number {
  if (config.preset === 'ev_charger_1_phase') return 230;
  return config.preset === 'ev_charger_3_phase' ? 690 : gridWatts;
}

async function buildCharger(grid: string, amps: number, charging: boolean): Promise<MockDevice> {
  const device = new MockDevice(ID, 'Enua Charge', [
    'measure_power', 'target_power', 'target_power_mode', 'evcharger_charging', 'evcharger_charging_state',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:no.enua', driverId: 'homey:app:no.enua:enua-charger' });
  device.setSettings({ grid_type: grid });
  // Shipped in both Enua 3.2.0 live and 3.2.1 test, regardless of grid type.
  device.setCapabilityMetadata('target_power', { min: 0, max: 22080, step: 230, setable: true, units: 'W' });
  const wattsPerAmp = GRIDS.find((candidate) => candidate.grid === grid)?.wattsPerAmp ?? 690;
  await device.setCapabilityValue('target_power', amps * wattsPerAmp);
  await device.setCapabilityValue('target_power_mode', 'homey');
  await device.setCapabilityValue('evcharger_charging', charging);
  await device.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in_paused');
  await device.setCapabilityValue('measure_power', charging ? amps * wattsPerAmp : 0);
  setMockDrivers({ chargers: new MockDriver('chargers', [device]) });
  return device;
}

/** External charger simulation, following Enua 3.2.x's shipped listeners and 30 s poll. */
function simulateEnua(charger: MockDevice, wattsPerAmp: number, chargingWattsPerAmp = wattsPerAmp) {
  let backgroundW = 1000;
  let limitA = Math.round(Number(charger.getActualCapabilityValue('target_power')) / wattsPerAmp);
  let enabled = charger.getActualCapabilityValue('evcharger_charging') === true;
  let maximumA = 32;
  let stopMode = 'device';
  let mode = 'homey';
  let roundReports = false;
  const startCurrents: number[] = [];
  const publish = (): void => {
    // Stopping does not zero wallmountUserSetAmpere: the next poll publishes
    // the positive limit again even while the charging switch is off.
    const targetW = limitA * wattsPerAmp;
    charger.setActualCapabilityValue('target_power', roundReports ? Math.round(targetW) : targetW);
    charger.setActualCapabilityValue('target_power_mode', mode);
    charger.setActualCapabilityValue('evcharger_charging', enabled);
    charger.setActualCapabilityValue('evcharger_charging_state', enabled ? 'plugged_in_charging' : 'plugged_in_paused');
    charger.setActualCapabilityValue('measure_power', enabled ? limitA * chargingWattsPerAmp : 0);
  };
  setInterval(publish, 30_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('target_power') && typeof value === 'number') {
      if (value === 0) {
        enabled = false;
        mode = stopMode;
      } else {
        limitA = Math.max(6, Math.min(maximumA, Math.round(value / wattsPerAmp)));
        mode = 'homey';
      }
    }
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') {
      enabled = value;
      if (value) startCurrents.push(limitA);
      else mode = stopMode;
    }
    // A capability write is ACKed immediately; physical readback arrives on
    // the next cloud poll. The whole-home meter sees the actual draw meanwhile.
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + (enabled ? limitA * chargingWattsPerAmp : 0) } }],
    };
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    return originalGet(path);
  });
  return {
    startCurrents,
    writes: () => putSpy.mock.calls.filter(([path]) => path.startsWith(`manager/devices/device/${ID}/capability/`)),
    powerWrites: () => putSpy.mock.calls.filter(([path]) => path === pathFor('target_power'))
      .map(([, body]) => (body as { value: number }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
    setInstallerLimit: (amps: number) => { maximumA = amps; },
    setStopMode: (nextMode: string) => { stopMode = nextMode; },
    reportRoundedWatts: () => { roundReports = true; },
  };
}

function configureRuntime(limitW: number): void {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitW / 1000);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: true });
  mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
}

async function readCharger() {
  const response = await api.ui_devices({ homey: mockHomeyInstance as never });
  const device = response.devices.find((candidate) => candidate.id === ID);
  if (!device) throw new Error('Enua missing from /ui_devices');
  return device;
}

describe.each(GRIDS)('Enua $grid at the SDK boundary', ({ grid, wattsPerAmp }) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 9, 28, 8, 2));
    resetMockHomey();
    setMockDrivers({});
    connectLiveFeed();
  });
  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('discovers only physically reachable power levels, with a 6 A minimum and 32 A maximum', async () => {
    const charger = await buildCharger(grid, 16, true);
    simulateEnua(charger, wattsPerAmp);
    configureRuntime(1000 + 16 * wattsPerAmp);
    await createApp().onInit();
    const steps = (await readCharger()).steppedLoadProfile?.steps;
    expect(steps?.map((step) => step.planningPowerW)).toEqual([
      0, ...Array.from({ length: 27 }, (_, index) => Math.round((index + 6) * wattsPerAmp)),
    ]);
  });

  it('reduces charging within the available power using grid-correct watts', async () => {
    const charger = await buildCharger(grid, 16, true);
    const simulation = simulateEnua(charger, wattsPerAmp);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.powerWrites().length).toBeGreaterThan(0);
    for (const watts of simulation.powerWrites().filter((value) => value > 0)) {
      expect(watts).toBeGreaterThanOrEqual(Math.round(6 * wattsPerAmp));
      expect(watts).toBeLessThanOrEqual(Math.round(11 * wattsPerAmp));
      expect(Math.abs(watts / wattsPerAmp - Math.round(watts / wattsPerAmp))).toBeLessThanOrEqual(1 / wattsPerAmp);
    }
    expect(Number(charger.getActualCapabilityValue('measure_power'))).toBeLessThanOrEqual(10 * wattsPerAmp);
  });

  it('keeps a stopped charger off when the house cannot afford 6 A', async () => {
    const charger = await buildCharger(grid, 32, false);
    const simulation = simulateEnua(charger, wattsPerAmp);
    configureRuntime(1000 + 5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(125_000);
    await drainPending();
    expect(simulation.startCurrents).toEqual([]);
    expect(charger.getActualCapabilityValue('measure_power')).toBe(0);
  });

  it('prepares a safe limit before resuming a stopped session with an old 32 A limit', async () => {
    const charger = await buildCharger(grid, 32, false);
    const simulation = simulateEnua(charger, wattsPerAmp);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(simulation.startCurrents).toEqual([]);
    // Preparation observes the ordinary five-minute restore pacing too.
    await vi.advanceTimersByTimeAsync(345_000);
    expect(simulation.startCurrents.length).toBeGreaterThan(0);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(charger.getActualCapabilityValue('evcharger_charging')).toBe(true);
  });

  it.each(SAVED_CONFIGS)('prepares the actual grid limit with a saved $mode', async ({ config }) => {
    const charger = await buildCharger(grid, 32, false);
    const carWatts = planningWattsPerAmp(config, wattsPerAmp);
    const simulation = simulateEnua(charger, wattsPerAmp, carWatts);
    configureRuntime(1000 + 10.5 * carWatts);
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, { [ID]: config });
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(365_000);
    expect(simulation.startCurrents.length).toBeGreaterThan(0);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual({ [ID]: config });
  });

  it.each([12, 20, 28].flatMap((amps) => [
    { amps, rounded: false }, { amps, rounded: true },
  ]))('matches full/realtime car-phase reads at $amps A (rounded=$rounded)', async ({ amps, rounded }) => {
    const charger = await buildCharger(grid, amps, true);
    await charger.setCapabilityValue('measure_power', amps * 690);
    if (rounded) await charger.setCapabilityValue('target_power', Math.round(amps * wattsPerAmp));
    const simulation = simulateEnua(charger, wattsPerAmp, 690);
    if (rounded) simulation.reportRoundedWatts();
    configureRuntime(1000 + amps * 690);
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
      [ID]: { enabled: true, preset: 'ev_charger_3_phase' },
    });
    await createApp().onInit();
    expect((await readCharger()).reportedStepId).toBe(`${amps}a`);
    await vi.advanceTimersByTimeAsync(31_000);
    const observedA = Number(charger.getActualCapabilityValue('target_power')) / wattsPerAmp;
    expect((await readCharger()).reportedStepId).toBe(`${Math.round(observedA)}a`);
  });

  it('waits for a complete power read instead of starting at an unknown limit', async () => {
    const charger = await buildCharger(grid, 32, false);
    const simulation = simulateEnua(charger, wattsPerAmp);
    charger.setApiCapabilityValue('target_power', null);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(simulation.startCurrents).toEqual([]);
    // The next vendor poll supplies the full read; normal preparation and
    // restore pacing can then resume without a binary-only fallback.
    await vi.advanceTimersByTimeAsync(375_000);
    expect(simulation.startCurrents.length).toBeGreaterThan(0);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
  });

  it.each(['device', 'homey'])(
    'stays stopped after a positive limit readback with stop mode %s (live/test app behavior)', async (stopMode) => {
      const charger = await buildCharger(grid, 6, true);
      const simulation = simulateEnua(charger, wattsPerAmp);
      simulation.setStopMode(stopMode);
      configureRuntime(1000 + 5 * wattsPerAmp);
      await createApp().onInit();
      await vi.advanceTimersByTimeAsync(185_000);
      expect(simulation.writes()).toContainEqual([pathFor('evcharger_charging'), { value: false }]);
      expect(charger.getActualCapabilityValue('evcharger_charging')).toBe(false);
      expect(charger.getActualCapabilityValue('target_power')).toBeCloseTo(6 * wattsPerAmp);
      expect(charger.getActualCapabilityValue('measure_power')).toBe(0);
      expect(charger.getActualCapabilityValue('target_power_mode')).toBe(stopMode);
      expect(simulation.startCurrents).toEqual([]);
    },
  );

  it('limits a running session, stops under pressure and resumes at a safe current when room returns', async () => {
    const charger = await buildCharger(grid, 16, true);
    const simulation = simulateEnua(charger, wattsPerAmp);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    simulation.setBackground(1000 + 12 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(charger.getActualCapabilityValue('evcharger_charging')).toBe(false);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(simulation.startCurrents.length).toBeGreaterThan(0);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(charger.getActualCapabilityValue('evcharger_charging')).toBe(true);
  });

  it('keeps an installer-clamped ceiling as observed truth after higher accepted targets', async () => {
    const charger = await buildCharger(grid, 16, true);
    const simulation = simulateEnua(charger, wattsPerAmp);
    simulation.setInstallerLimit(16);
    configureRuntime(1000 + 40 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(425_000);
    expect(simulation.powerWrites().some((watts) => watts > 16 * wattsPerAmp)).toBe(true);
    expect(charger.getActualCapabilityValue('measure_power')).toBeCloseTo(16 * wattsPerAmp);
    expect((await readCharger()).reportedStepId).toBe(`${Math.round(16 * wattsPerAmp)}w`);
  });
});
