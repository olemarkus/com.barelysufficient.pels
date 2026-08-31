// Unit tier on purpose: every case calls the pure `buildInitialPlanDevices`
// directly — no I/O, no SDK, no clock — and asserts its return. Extracted from
// `test/integration/planDevices.test.ts` (which keeps the seam-driven cases).
import { planContextPower } from '../utils/planContextPowerFixture';
import { buildInitialPlanDevices } from '../../lib/plan/planDevices';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PlanDevicesDeps } from '../../lib/plan/planDevices';
import type { DevicePlanDevice, PlanInputDevice } from '../../lib/plan/planTypes';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { buildExecutableTargetIntent } from '../../lib/executor/executableTargetProjection';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { PriceLevel } from '../../lib/price/priceLevels';

// A plain, unremarkable meter reading: fixtures that only need power to be
// MEASURED say so through the reading, the way production does.
const FIXTURE_TOTAL_KW = 3;

const inputDevice = (
  o: Parameters<typeof buildPlanInputDevice>[0] = {},
): PlanInputDevice => buildPlanInputDevice(o);

/** Narrow a plan device to read its commanded `plannedTarget` in assertions. */
const plannedTargetOf = (device: DevicePlanDevice): number | undefined =>
  (isTemperaturePlanDevice(device) ? device.plannedTarget : undefined);

/** Narrow a plan device to read its observed `currentTarget` in assertions. */
const currentTargetOf = (device: DevicePlanDevice): number | null | undefined =>
  (isTemperaturePlanDevice(device) ? device.currentTarget : undefined);

const buildContext = (devices: PlanContext['devices']): PlanContext => ({
  devices,
  modeTargetCFor: (d) => d.currentTarget,
  ...planContextPower(FIXTURE_TOTAL_KW),
  hourBucketKey: '2025-01-01T00',
  softLimit: 2,
  capacitySoftLimit: 2,
  dailySoftLimit: null,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource: 'capacity',
  budgetReleasableHeadroomHold: false,
  capacityHeadroomKw: 1,
  budgetHeadroomKw: null,
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: -1,
  headroom: -1,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: PriceLevel.UNKNOWN,
});

const defaultDeps: PlanDevicesDeps = {
  getInferredSurplusKw: () => 0,
  getShedBehavior: () => ({ action: 'turn_off' }),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
};

// A mode target is the only load-adding thing the planner commands as an
// ordinary `target_update`: it consults neither headroom nor the restore
// cooldowns, so with no usable meter reading it would drive a device against
// a completely unknown draw. Binding mode targets live for meter-area homes
// (see setup/homeRuntime/createHomeCapacityBundle.ts) made that reachable for
// an area whose meter never reports. The hold is class-aware (a raise for
// heat devices, both directions for cooling-capable classes), anchors to the
// EXACT observed setpoint, and fails closed when no observation exists.
describe('unknown power holds a load-adding mode-target change', () => {
  // A room heater, so the capability range spans the 16-22 °C values below.
  // (The water-tank fixture used elsewhere in this file has `min: 30`, which
  // `normalizeTargetCapabilityValue` would clamp every assertion up to.)
  const heater = (targetValue: number) => inputDevice({
    id: 'tank',
    name: 'Panel heater',
    deviceType: 'temperature',
    currentTemperature: 19,
    currentTarget: targetValue,
    targets: [{ id: 'target_temperature', value: targetValue, unit: '°C', min: 5, max: 35 }],
  });
  const build = (params: {
    targetValue: number;
    modeTarget: number;
    powerKnown: boolean;
    holdsRaises?: boolean;
  }) => (
    buildInitialPlanDevices({
      context: {
        ...buildContext([heater(params.targetValue)]),
        modeTargetCFor: (d) => (({ tank: params.modeTarget })[d.id] ?? d.currentTarget),
        powerIsMeasured: params.powerKnown,
        // The two readings `powerKnown === false` is derived from; kept
        // consistent so the fixture cannot pass on a contradictory context.
        ...(params.powerKnown ? {} : { total: null, powerFreshnessState: 'stale_hold' as const }),
      },
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        ...defaultDeps,
        holdsModeTargetRaisesWhilePowerUnknown: () => params.holdsRaises ?? true,
      },
    })[0]
  );

  it('clamps a raise to the device\'s own setpoint, so the executor drops the write', () => {
    const planDevice = build({ targetValue: 18, modeTarget: 22, powerKnown: false });

    expect(plannedTargetOf(planDevice)).toBe(18);
    expect(currentTargetOf(planDevice)).toBe(18);
    // Equal planned/current is exactly what `buildExecutableTargetUpdate` drops.
    expect(buildExecutableTargetIntent(planDevice)?.desired).toBe(18);
  });

  it('still applies a mode target that LOWERS the setpoint (that removes draw)', () => {
    // The whole point of the hold is not adding load. Switching to Away must
    // keep working while the meter is quiet, or PELS would strand the home
    // consuming MORE than the user asked for.
    const planDevice = build({ targetValue: 22, modeTarget: 16, powerKnown: false });

    expect(plannedTargetOf(planDevice)).toBe(16);
  });

  it('applies the raise normally once the meter reading is known', () => {
    const planDevice = build({ targetValue: 18, modeTarget: 22, powerKnown: true });

    expect(plannedTargetOf(planDevice)).toBe(22);
  });

  it('leaves a home that does not opt in (main) commanding the raise', () => {
    // The hold is a per-home posture, not a global rule: main binds `false`
    // (`buildMainHomeScope`) because it owns its own settle/dwell handling of
    // the power-goes-unknown transition.
    const planDevice = build({
      targetValue: 18, modeTarget: 22, powerKnown: false, holdsRaises: false,
    });

    expect(plannedTargetOf(planDevice)).toBe(22);
  });

  it('holds at the EXACT observed value, not its step-normalized round-up', () => {
    // A driver reporting an off-step 18.6 with a 1° step would normalize to
    // 19 — a load-adding write the executor could not recognize as a no-op
    // (Object.is(18.6, 19) is false). The hold must emit 18.6 verbatim.
    const [planDevice] = buildInitialPlanDevices({
      context: {
        ...buildContext([inputDevice({
          id: 'tank',
          name: 'Panel heater',
          deviceType: 'temperature',
          currentTemperature: 18,
          currentTarget: 18.6,
          targets: [{ id: 'target_temperature', value: 18.6, unit: '°C', min: 5, max: 35, step: 1 }],
        })]),
        modeTargetCFor: (d) => (({ tank: 22 })[d.id] ?? d.currentTarget),
        ...planContextPower(null),
      },
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: { ...defaultDeps, holdsModeTargetRaisesWhilePowerUnknown: () => true },
    });

    expect(plannedTargetOf(planDevice)).toBe(18.6);
    expect(buildExecutableTargetIntent(planDevice)?.desired).toBe(18.6);
  });

  it('holds BOTH directions for a cooling-capable class, where lowering adds load', () => {
    // For an AC / reversible heat pump in cooling mode, 24→20 adds compressor
    // load. PELS cannot observe which mode the unit is in, so while power is
    // unknown the class holds every change; with a fresh reading the mode
    // target applies normally.
    const airconditioner = (powerKnown: boolean) => buildInitialPlanDevices({
      context: {
        ...buildContext([inputDevice({
          id: 'tank',
          name: 'Bedroom AC',
          deviceType: 'temperature',
          deviceClass: 'airconditioning',
          currentTemperature: 25,
          currentTarget: 24,
          targets: [{ id: 'target_temperature', value: 24, unit: '°C', min: 5, max: 35 }],
        })]),
        modeTargetCFor: (d) => (({ tank: 20 })[d.id] ?? d.currentTarget),
        ...(powerKnown ? {} : {
          total: null,
          // The field the hold actually reads. Before 2026-08-07 this fixture set
          // `powerKnown: false` alone and the stale companion number stayed
          // inherited — the two-correlated-fields hazard the resolved field exists
          // to remove.
          ...planContextPower(null),
        }),
      },
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: { ...defaultDeps, holdsModeTargetRaisesWhilePowerUnknown: () => true },
    })[0];

    expect(plannedTargetOf(airconditioner(false))).toBe(24);
    expect(plannedTargetOf(airconditioner(true))).toBe(20);
  });

  it('treats the ambiguous thermostat class as cooling-capable (a heat pump can register as one)', () => {
    // The generic `thermostat` class cannot prove heat-only hardware — the
    // repo's own e2e fixture models a heat pump under it — so a lowering mode
    // target must hold while power is unknown, exactly like an explicit
    // cooling class. Only `heater` promises heating-only and keeps the
    // raise-only rule.
    const byClass = (deviceClass: string) => buildInitialPlanDevices({
      context: {
        ...buildContext([inputDevice({
          id: 'tank',
          name: 'Living room unit',
          deviceType: 'temperature',
          deviceClass,
          currentTemperature: 23,
          currentTarget: 24,
          targets: [{ id: 'target_temperature', value: 24, unit: '°C', min: 5, max: 35 }],
        })]),
        modeTargetCFor: (d) => (({ tank: 20 })[d.id] ?? d.currentTarget),
        ...planContextPower(null),
      },
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: { ...defaultDeps, holdsModeTargetRaisesWhilePowerUnknown: () => true },
    })[0];

    expect(plannedTargetOf(byClass('thermostat'))).toBe(24);
    expect(plannedTargetOf(byClass('heater'))).toBe(20);
  });

  it('does not hold a deadline floor, which is a promise rather than opportunistic load', () => {
    const [planDevice] = buildInitialPlanDevices({
      context: {
        ...buildContext([inputDevice({
          id: 'tank',
          name: 'Water tank',
          deviceType: 'temperature',
          currentTemperature: 45,
          targets: [{ id: 'target_temperature', value: 50, unit: '°C', min: 30, max: 70 }],
          deadlineFloorTargetC: 60,
        })]),
        modeTargetCFor: (d) => (({ tank: 55 })[d.id] ?? d.currentTarget),
        ...planContextPower(null),
      },
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: { ...defaultDeps, holdsModeTargetRaisesWhilePowerUnknown: () => true },
    });

    expect(plannedTargetOf(planDevice)).toBe(60);
  });
});
