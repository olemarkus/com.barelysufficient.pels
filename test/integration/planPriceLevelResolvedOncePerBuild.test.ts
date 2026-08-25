import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import type {
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsRecorder,
} from '../../lib/diagnostics/deviceDiagnosticsService';
import type { DevicePlanDevice, PlanInputDevice } from '../../lib/plan/planTypes';

// The tracker is the single power latch; tests drive the whole-home total here.
let lastPowerW = 0;

/**
 * Resolving the current-hour price level is NOT cheap: it rebuilds the entire
 * combined price series out of settings (`PriceService.getCombinedHourlyPrices`
 * has no cache), which measured ~25 ms per call on a Homey Pro. The device
 * materialization loop and the diagnostics observation loop used to ask per
 * device, so a 13-device home paid 52 rebuilds — ~1.28 s of a ~1.29 s plan
 * build, one 85–116 % CPU spike per rebuild, and every 10-second power sample
 * queued behind it.
 *
 * The level is now producer-resolved once per build onto
 * `PlanContext.currentHourPriceLevel`, through the single
 * `getCurrentHourPriceLevel` seam that answers both flags from one series build.
 * This suite pins the property that regressed: the call count must not scale
 * with the device count.
 */
const DEVICE_COUNT = 13;

const temperatureDevice = (id: string): PlanInputDevice => buildPlanInputDevice({
  id,
  name: `Heater ${id}`,
  deviceType: 'temperature',
  currentTemperature: 19,
  targets: [{ id: 'target_temperature', value: 20, unit: 'C' }],
  controllable: true,
  measuredPowerKw: 0.4,
});

const plannedTargetOf = (device: DevicePlanDevice | undefined): number | undefined => (
  device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined
);

/**
 * `PlanMaterializationStages.observeDiagnostics` short-circuits on a missing
 * recorder, and the diagnostics loop is HALF the cost this change removes — so a
 * builder without one would leave `buildDeviceDiagnosticsObservations` unrun and
 * the assertions below blind to a per-device call re-appearing there.
 */
const buildDiagnosticsRecorder = (): DeviceDiagnosticsRecorder & {
  observed: DeviceDiagnosticsPlanObservation[][];
} => {
  const observed: DeviceDiagnosticsPlanObservation[][] = [];
  return {
    observed,
    observePlanSample: ({ observations }) => { observed.push(observations); },
    recordControlEvent: vi.fn(),
    recordActivationTransition: vi.fn(),
    getUiPayload: vi.fn(),
  } as DeviceDiagnosticsRecorder & { observed: DeviceDiagnosticsPlanObservation[][] };
};

const buildBuilder = (params: {
  priceOptimizationEnabled: boolean;
  getCurrentHourPriceLevel: () => { cheap: boolean; expensive: boolean };
  deviceIds: string[];
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  /** Omit to configure every device; `{}` reproduces an unconfigured install. */
  priceOptimizationSettings?: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
}): PlanBuilder => {
  const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
  lastPowerW = (3) * 1000;
  return new PlanBuilder({
      getCapacityDryRun: () => false,
    capacityGuard: capacityGuard,
    setCapacityInShortfall: vi.fn(),
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0.2 }),
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({
      Home: Object.fromEntries(params.deviceIds.map((id) => [id, 20])),
    }),
    getPriceOptimizationEnabled: () => params.priceOptimizationEnabled,
    getPriceOptimizationSettings: () => params.priceOptimizationSettings ?? Object.fromEntries(
      params.deviceIds.map((id) => [id, { enabled: true, cheapDelta: 2, expensiveDelta: -2 }]),
    ),
    getCurrentHourPriceLevel: params.getCurrentHourPriceLevel,
    getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
    getDailyBudgetSnapshot: () => null,
    getPriorityForDevice: () => 100,
    getShedBehavior: () => ({ action: 'turn_off' }),
    getDynamicSoftLimitOverride: () => 10,
    deviceDiagnostics: params.deviceDiagnostics,
    log: vi.fn(),
    logDebug: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  }, createPlanEngineState());
};

describe('current-hour price level is resolved once per plan build', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T10:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the price service at most once per build, not once per device', async () => {
    const getCurrentHourPriceLevel = vi.fn(() => ({ cheap: true, expensive: false }));
    const deviceIds = Array.from({ length: DEVICE_COUNT }, (_, i) => `heater-${i}`);
    const deviceDiagnostics = buildDiagnosticsRecorder();

    const builder = buildBuilder({
      priceOptimizationEnabled: true,
      getCurrentHourPriceLevel,
      deviceIds,
      deviceDiagnostics,
    });
    const plan = await builder.buildDevicePlanSnapshot(deviceIds.map(temperatureDevice));

    expect(plan.devices).toHaveLength(DEVICE_COUNT);
    // Both per-device loops ran: materialization produced the plan devices, and the
    // diagnostics observation produced one observation each.
    expect(deviceDiagnostics.observed).toEqual([expect.arrayContaining([
      expect.objectContaining({ deviceId: 'heater-0' }),
    ])]);
    expect(deviceDiagnostics.observed[0]).toHaveLength(DEVICE_COUNT);
    expect(getCurrentHourPriceLevel).toHaveBeenCalledTimes(1);
  });

  it('shares the one resolution with the diagnostics loop (desired target carries the delta)', async () => {
    const getCurrentHourPriceLevel = vi.fn(() => ({ cheap: true, expensive: false }));
    const deviceIds = Array.from({ length: DEVICE_COUNT }, (_, i) => `heater-${i}`);
    const deviceDiagnostics = buildDiagnosticsRecorder();

    const builder = buildBuilder({
      priceOptimizationEnabled: true,
      getCurrentHourPriceLevel,
      deviceIds,
      deviceDiagnostics,
    });
    await builder.buildDevicePlanSnapshot(deviceIds.map(temperatureDevice));

    // mode 20 + cheapDelta 2, formatted by `buildDiagnosticsObservation` — proves the
    // diagnostics loop read the shared level rather than its own per-device call.
    expect(deviceDiagnostics.observed[0].map((o) => o.desiredStateSummary))
      .toEqual(new Array(DEVICE_COUNT).fill('22.0C'));
    expect(getCurrentHourPriceLevel).toHaveBeenCalledTimes(1);
  });

  it('still applies the cheap-hour delta to every configured device', async () => {
    const deviceIds = Array.from({ length: DEVICE_COUNT }, (_, i) => `heater-${i}`);
    const builder = buildBuilder({
      priceOptimizationEnabled: true,
      getCurrentHourPriceLevel: () => ({ cheap: true, expensive: false }),
      deviceIds,
    });

    const plan = await builder.buildDevicePlanSnapshot(deviceIds.map(temperatureDevice));

    // mode target 20 + cheapDelta 2 on every device — the single resolution is
    // shared, not spent on the first device.
    expect(plan.devices.map(plannedTargetOf)).toEqual(new Array(DEVICE_COUNT).fill(22));
  });

  it('applies the expensive-hour delta from the same single resolution', async () => {
    const deviceIds = ['heater-0', 'heater-1'];
    const getCurrentHourPriceLevel = vi.fn(() => ({ cheap: false, expensive: true }));
    const builder = buildBuilder({
      priceOptimizationEnabled: true,
      getCurrentHourPriceLevel,
      deviceIds,
    });

    const plan = await builder.buildDevicePlanSnapshot(deviceIds.map(temperatureDevice));

    expect(plan.devices.map(plannedTargetOf)).toEqual([18, 18]);
    expect(getCurrentHourPriceLevel).toHaveBeenCalledTimes(1);
  });

  it('makes no price call when the global switch is on but no device is configured', async () => {
    // The default install: `PRICE_OPTIMIZATION_ENABLED` is unset, and the store reads
    // `homey.settings.get(...) !== false`, so the global switch is ON while the
    // per-device map is still empty. Both consumers guard on `config?.enabled`, so
    // this home never spends a price level — resolving one would charge it two full
    // price-series rebuilds on every power-triggered plan rebuild for nothing.
    const getCurrentHourPriceLevel = vi.fn(() => ({ cheap: true, expensive: false }));
    const deviceIds = Array.from({ length: DEVICE_COUNT }, (_, i) => `heater-${i}`);

    const builder = buildBuilder({
      priceOptimizationEnabled: true,
      priceOptimizationSettings: {},
      getCurrentHourPriceLevel,
      deviceIds,
      deviceDiagnostics: buildDiagnosticsRecorder(),
    });
    const plan = await builder.buildDevicePlanSnapshot(deviceIds.map(temperatureDevice));

    expect(getCurrentHourPriceLevel).not.toHaveBeenCalled();
    expect(plan.devices.map(plannedTargetOf)).toEqual(new Array(DEVICE_COUNT).fill(20));
  });

  it('still resolves when only one of many devices is configured', async () => {
    const getCurrentHourPriceLevel = vi.fn(() => ({ cheap: true, expensive: false }));
    const deviceIds = Array.from({ length: DEVICE_COUNT }, (_, i) => `heater-${i}`);

    const builder = buildBuilder({
      priceOptimizationEnabled: true,
      priceOptimizationSettings: { 'heater-7': { enabled: true, cheapDelta: 2, expensiveDelta: -2 } },
      getCurrentHourPriceLevel,
      deviceIds,
    });
    const plan = await builder.buildDevicePlanSnapshot(deviceIds.map(temperatureDevice));

    expect(getCurrentHourPriceLevel).toHaveBeenCalledTimes(1);
    // Only the configured device takes the delta; the rest keep the bare mode target.
    expect(plan.devices.filter((d) => d.id === 'heater-7').map(plannedTargetOf)).toEqual([22]);
    expect(plan.devices.filter((d) => d.id !== 'heater-7').map(plannedTargetOf))
      .toEqual(new Array(DEVICE_COUNT - 1).fill(20));
  });

  it('makes no price call at all when price optimization is switched off', async () => {
    const getCurrentHourPriceLevel = vi.fn(() => ({ cheap: true, expensive: false }));
    const deviceIds = Array.from({ length: DEVICE_COUNT }, (_, i) => `heater-${i}`);

    const builder = buildBuilder({
      priceOptimizationEnabled: false,
      getCurrentHourPriceLevel,
      deviceIds,
      deviceDiagnostics: buildDiagnosticsRecorder(),
    });
    const plan = await builder.buildDevicePlanSnapshot(deviceIds.map(temperatureDevice));

    expect(getCurrentHourPriceLevel).not.toHaveBeenCalled();
    // Unmodulated mode target — the master switch is off.
    expect(plan.devices.map(plannedTargetOf)).toEqual(new Array(DEVICE_COUNT).fill(20));
  });
});
