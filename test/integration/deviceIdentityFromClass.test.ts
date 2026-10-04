/**
 * The class -> identity flag -> behaviour chain, driven from raw Homey devices.
 *
 * The device layer resolves the inventory class ONCE: the parse producer
 * (`managerParseDeviceFields`) stamps `isEvCharger` and `observeOnly`, and device
 * configuration (`DeviceConfigurationStore`) copies them and resolves
 * `starvationSupported`. Everything downstream reads those flags and never the
 * class, so a fixture that hands the planner a pre-set flag proves nothing about
 * whether a real device ever gets one. Here nothing is hand-set: each device
 * goes through the real parse (`parseDeviceListForTests`), the real
 * configuration store, the real Observer projection and planner-input producer
 * (`createAppContextMock` + `toPlanDevice`), and the real plan stages.
 *
 * Integration tier: only the SDK seam is simulated (the shared homey mock and
 * hand-built device reads).
 */
import { describe, expect, it, vi } from 'vitest';
import type Homey from 'homey';
import { createTestDeviceTransport } from '../helpers/deviceTransportHarness';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { mockHomeyInstance } from '../mocks/homey';
import { DeviceConfigurationStore } from '../../lib/device/deviceConfiguration';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { CapabilityValue, HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { toPlanDevice } from '../../setup/appInit';
import { buildInitialPlanDevices, type PlanDevicesDeps } from '../../lib/plan/planDevices';
import { buildDeviceDiagnosticsObservations } from '../../lib/plan/planDiagnostics';
import { buildSettingsOverviewReadModel } from '../../lib/plan/settingsOverviewReadModel';
import type { RestorePlanResult } from '../../lib/plan/restore';
import type { DevicePlanDevice, PlanInputDevice } from '../../lib/plan/planTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildPlanCycleObject, type PlanCycle } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanMeta, restoreTimingFixture, sheddingPlanFixture } from '../utils/planTestUtils';
import { executionStateFixture } from '../utils/deviceStatusFixture';

const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};

// Homey dates every capability value it reports; an undated value is not a read.
const lastUpdated = new Date().toISOString();
const cap = <T>(value: T, extra: Omit<CapabilityValue<T>, 'value' | 'lastUpdated'> = {}): CapabilityValue<T> => (
  { value, lastUpdated, ...extra }
);

const rawDevice = (
  id: string,
  deviceClass: string,
  capabilitiesObj: Record<string, CapabilityValue<unknown>>,
): HomeyDeviceLike => ({
  id,
  name: `${deviceClass} ${id}`,
  class: deviceClass,
  capabilities: Object.keys(capabilitiesObj),
  capabilitiesObj,
  available: true,
  ready: true,
});

const onoffCaps = (): Record<string, CapabilityValue<unknown>> => ({
  onoff: cap(true, { setable: true }),
  measure_power: cap(1_200),
});

const temperatureCaps = (): Record<string, CapabilityValue<unknown>> => ({
  target_temperature: cap(21, { units: '°C', min: 5, max: 30, step: 0.5, setable: true }),
  measure_temperature: cap(19),
  measure_power: cap(800),
});

// One raw read per admitted class, each with the capabilities a real device of
// that class reports. Note what identifies a charger here: its class. The
// charging switch is only ever selected as the control axis FOR that class.
const RAW_DEVICES: Record<string, HomeyDeviceLike> = {
  thermostat: rawDevice('thermostat-1', 'thermostat', temperatureCaps()),
  heater: rawDevice('heater-1', 'heater', onoffCaps()),
  heatpump: rawDevice('heatpump-1', 'heatpump', { onoff: cap(true, { setable: true }), ...temperatureCaps() }),
  airconditioning: rawDevice('ac-1', 'airconditioning', { onoff: cap(true, { setable: true }), ...temperatureCaps() }),
  airtreatment: rawDevice('airtreatment-1', 'airtreatment', onoffCaps()),
  battery: rawDevice('battery-1', 'battery', { measure_battery: cap(62), measure_power: cap(1_200) }),
  solarpanel: rawDevice('solar-1', 'solarpanel', { measure_power: cap(3_000), meter_power: cap(42) }),
  evcharger: rawDevice('ev-1', 'evcharger', {
    evcharger_charging: cap(false, { setable: true }),
    evcharger_charging_state: cap('plugged_in_paused'),
    measure_power: cap(0),
  }),
  socket: rawDevice('socket-1', 'socket', onoffCaps()),
};

const parse = (devices: HomeyDeviceLike[]): TransportDeviceSnapshot[] => createTestDeviceTransport(
  mockHomeyInstance as unknown as Homey.App,
  loggerMock,
  {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
    getManaged: () => true,
    getControllable: () => true,
  },
).parseDeviceListForTests(devices);

describe('identity resolved from the class at parse and in device configuration', () => {
  it.each([
    ['thermostat', { isEvCharger: false, observeOnly: false, starvationSupported: true }],
    ['heater', { isEvCharger: false, observeOnly: false, starvationSupported: true }],
    ['heatpump', { isEvCharger: false, observeOnly: false, starvationSupported: true }],
    ['airconditioning', { isEvCharger: false, observeOnly: false, starvationSupported: true }],
    ['airtreatment', { isEvCharger: false, observeOnly: false, starvationSupported: true }],
    ['battery', { isEvCharger: false, observeOnly: true, starvationSupported: false }],
    ['solarpanel', { isEvCharger: false, observeOnly: true, starvationSupported: false }],
    ['evcharger', { isEvCharger: true, observeOnly: false, starvationSupported: false }],
    ['socket', { isEvCharger: false, observeOnly: false, starvationSupported: false }],
  ] as const)('a raw %s device parses and configures to its identity facts', (deviceClass, expected) => {
    const raw = RAW_DEVICES[deviceClass]!;
    const [parsed] = parse([raw]);

    // The parse producer stamps the two facts it owns from the class.
    expect(parsed).toMatchObject({
      id: raw.id,
      deviceClass,
      isEvCharger: expected.isEvCharger,
      observeOnly: expected.observeOnly,
    });

    // Device configuration carries them and resolves starvation support.
    const store = new DeviceConfigurationStore();
    store.replace([parsed!]);
    expect(store.get(raw.id)).toMatchObject(expected);
  });
});

const THERMOSTAT_ID = RAW_DEVICES.thermostat!.id;
const BATTERY_ID = RAW_DEVICES.battery!.id;

// A real epoch, not 0: `nowTs` is `Date.now()` in production and dates the
// ceiling shortfall's recent-shed window.
const FIXTURE_NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

const emptyRestoreResult: RestorePlanResult = {
  planDevices: [],
  restoredThisCycle: new Set<string>(),
  headroomReserves: [],
  availableHeadroom: 8,
  capacityAvailableKw: 8,
  budgetAvailableKw: null,
  restoredOneThisCycle: false,
  timing: restoreTimingFixture({ nowTs: FIXTURE_NOW_MS, restoreCooldownMs: 60 * 1000 }),
};

const planDevicesDeps: PlanDevicesDeps = {
  getInferredSurplusKw: () => 0,
  getShedBehavior: () => ({ action: 'turn_off' }),
  getPriceOptimizationSettings: () => ({}),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
};

/**
 * Plan a thermostat and a home battery from their raw reads: parse, then the
 * production planner-input composition (device configuration joined with the
 * Observer record, `getPlanInputSnapshot`), then `toPlanDevice` exactly as the
 * snapshot passes call it. The thermostat is managed and power-limited; the
 * battery is the managed observe-only device the parse stamps it as.
 */
const planFromRawDevices = (): { context: PlanCycle; planDevices: DevicePlanDevice[] } => {
  const ctx = createAppContextMock({
    latestTargetSnapshot: parse([RAW_DEVICES.thermostat!, RAW_DEVICES.battery!]),
  });
  ctx.resolveManagedState = vi.fn(() => true);
  ctx.isCapacityControlEnabled = vi.fn((deviceId: string) => deviceId === THERMOSTAT_ID);
  const devices = ctx.getPlanInputSnapshot().map((device, index) => ({
    ...toPlanDevice(ctx, device),
    priority: index + 1,
  }) as PlanInputDevice);
  // The flags reached planner input from configuration, not from the fixture.
  expect(devices.find((device) => device.id === BATTERY_ID)).toMatchObject({ observeOnly: true });
  expect(devices.find((device) => device.id === THERMOSTAT_ID)).toMatchObject({
    observeOnly: false,
    starvationSupported: true,
  });
  const context = buildPlanCycleObject({
    devices,
    intent: { getModeDeviceTargets: () => ({ Home: { [THERMOSTAT_ID]: 21 } }) },
    total: 2,
    hourBucketKey: '2026-01-01T12',
    softLimit: 10,
    capacitySoftLimit: 10,
    dailySoftLimit: null,
    budgetPaceKw: null,
    projectedExemptKw: null,
    softLimitSource: 'capacity',
    budgetReleasableHeadroomHold: false,
    capacityHeadroomKw: 8,
    budgetHeadroomKw: null,
    budgetKWh: 0,
    usedKWh: 0,
    minutesRemaining: 60,
    headroomRaw: 8,
    headroom: 8,
  });
  const planDevices = buildInitialPlanDevices({
    context,
    state: createPlanEngineState(FIXTURE_NOW_MS),
    sheddingPlan: sheddingPlanFixture(),
    shortfall: { inShortfall: false },
    deps: planDevicesDeps,
  });
  return { context, planDevices };
};

describe('class-resolved identity through the plan build', () => {
  it('leaves a battery-class device out of the settings overview and keeps a thermostat', () => {
    const { planDevices } = planFromRawDevices();
    // The planner still observes the battery; hiding it is the overview's job.
    expect(planDevices.map((device) => device.id).sort()).toEqual([BATTERY_ID, THERMOSTAT_ID].sort());

    const overview = buildSettingsOverviewReadModel({
      meta: buildPlanMeta({ totalKw: 2, softLimitKw: 10, headroomKw: 8 }),
      devices: planDevices,
    }, {
      getDeviceExecutionState: (deviceId) => {
        const device = planDevices.find((candidate) => candidate.id === deviceId);
        if (!device) throw new Error(`missing plan device ${deviceId}`);
        return executionStateFixture(device);
      },
      dryRun: false,
      nowMs: FIXTURE_NOW_MS,
      getObservedEvChargingState: () => ({ kind: 'absent' }),
      getObservedStateOfCharge: () => ({ kind: 'absent' }),
      getObservedTemperature: () => ({ kind: 'absent' }),
    });

    expect((overview?.devices ?? []).map((device) => device.id)).toEqual([THERMOSTAT_ID]);
  });

  it('makes a thermostat-class device starvation-eligible and leaves the battery ineligible', () => {
    const { context, planDevices } = planFromRawDevices();

    const observations = buildDeviceDiagnosticsObservations({
      context,
      power: context,
      planDevices,
      restoreResult: emptyRestoreResult,
      budgetPressureEligible: false,
      smartTaskDrivingDeviceIds: new Set<string>(),
    });

    expect(observations.find((o) => o.deviceId === THERMOSTAT_ID)?.eligibleForStarvation).toBe(true);
    expect(observations.find((o) => o.deviceId === BATTERY_ID)?.eligibleForStarvation).toBe(false);
  });
});
