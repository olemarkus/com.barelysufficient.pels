import { planContextPower } from '../utils/planContextPowerFixture';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { buildInitialPlanDevices } from '../../lib/plan/planDevices';
import {
  MISSING_MODE_TARGET_EMIT_INTERVAL_MS,
  cleanupMissingModeTargetDevices,
} from '../../lib/plan/planModeTargetGuard';
import { createPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PlanDevicesDeps } from '../../lib/plan/planDevices';
import type {
  BinaryControlDiscriminantProbe,
  DevicePlanDevice,
  PlanInputDevice,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import {
  isDeviceObservationStale,
  STALE_DEVICE_OBSERVATION_MS,
} from '../../lib/observer/observationFreshness';
import {
  buildPlanInputDevice,
  type FixtureBoostFields,
  steppedInputDevice,
} from '../utils/planTestUtils';
import { fixtureDeviceReason, reasonText } from '../utils/deviceReasonTestUtils';

// A plain, unremarkable meter reading: fixtures that only need power to be
// MEASURED say so through the reading, the way production does.
const FIXTURE_TOTAL_KW = 3;

/**
 * Local fixture wrappers that widen the stable shared builders with the
 * discriminant probes this file's fixtures exercise (temperature / binary / EV).
 * The stable builders already regroup those clusters internally; the wrappers
 * only re-open the param type so the loose fixture literals typecheck, then
 * forward unchanged.
 */
const inputDevice = (
  o: Partial<PlanInputDevice>
    & BinaryControlDiscriminantProbe
    & TemperatureDiscriminantProbe
    & FixtureBoostFields
    & {
      evChargingState?: string;
      binaryCapabilityId?: string;
      deviceType?: 'temperature' | 'onoff';
    } = {},
): PlanInputDevice => buildPlanInputDevice(o as Parameters<typeof buildPlanInputDevice>[0]);

const steppedInput = (
  o: Partial<PlanInputDevice>
    & BinaryControlDiscriminantProbe
    & TemperatureDiscriminantProbe
    & FixtureBoostFields
    & {
      evChargingState?: string;
      binaryCapabilityId?: string;
      deviceType?: 'temperature' | 'onoff';
    } = {},
): PlanInputDevice => steppedInputDevice(o as Parameters<typeof steppedInputDevice>[0]);

/** Build a `shedReasons` map from string reason codes (test convenience). */
const shedReasonMap = (entries: [string, string][]): Map<string, NonNullable<ReturnType<typeof fixtureDeviceReason>>> =>
  new Map(entries.map(([id, reason]) => [id, fixtureDeviceReason(reason)!]));

/** Narrow a plan device to read its commanded `plannedTarget` in assertions. */
const plannedTargetOf = (device: DevicePlanDevice): number | undefined =>
  (isTemperaturePlanDevice(device) ? device.plannedTarget : undefined);


/** The plan device's one boost flag. There is no second one, and no kind behind it. */
const boostActiveOf = (device: DevicePlanDevice): boolean => device.boostActive;

const buildContext = (devices: PlanContext['devices']): PlanContext => ({
  devices,
  desiredForMode: {},
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
  currentHourPriceLevel: { cheap: false, expensive: false },
});

// Shared empty pending-binary-command store for the many cases that do not
// seed pending state. Tests that DO seed `state.pendingBinaryCommands` bind a
// store to their own state (see `pendingStoreFor`).
const emptyPendingStore = createPendingBinaryCommandStore({});
const pendingStoreFor = (state: PlanEngineState) =>
  createPendingBinaryCommandStore(state.pendingBinaryCommands);

const defaultDeps: PlanDevicesDeps = {
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  pendingBinaryCommandStore: emptyPendingStore,
};

let logCapture: LoggerCapture;
beforeEach(() => { logCapture = captureLogger(); });
afterEach(() => { logCapture.restore(); });

describe('buildInitialPlanDevices', () => {
  it('activates strictly below the floor with no exit-margin hysteresis', () => {
    // `state` persists across build() calls, so the first call leaves the device
    // previously-active. With the dropped TEMPERATURE_BOOST_EXIT_MARGIN_C there is no
    // exit band: a previously-active device at 56.5 °C (above its 55 °C floor) ends
    // immediately rather than coasting to floor+2. The device's own thermostat deadband
    // supplies the physical hysteresis.
    const state = createPlanEngineState();
    const build = (currentTemperature: number) => buildInitialPlanDevices({
      context: buildContext([steppedInput({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    })[0];

    expect(build(54.9).boostActive).toBe(true);
    expect(build(56.5).boostActive).toBe(false);
    expect(build(57).boostActive).toBe(false);
  });

  it('enables temperature boost from the producer-resolved temperature (plan does not distrust the observer)', () => {
    // Behaviour change (trust the observer): the plan device no longer carries
    // observation staleness, and the plan has no right to distrust observer data.
    // Temperature boost is resolved from the producer-resolved temperature
    // (finiteness-checked, not gated on staleness at the plan layer), so a device
    // below its floor boosts on the last-seen temperature. (`getTrustedCurrentTemperatureC`
    // still drops a non-finite reading — only the staleness gate is gone.)
    //
    // The boost decision reads ONLY `currentTemperature` — it has no freshness
    // input at this layer by design, so the trusted-last-seen behaviour holds
    // regardless of age. The assertion below documents that the chosen age IS
    // stale by the real resolver; it is NOT wired into the boost path (a genuine
    // reintroduction guard isn't constructible here without first re-plumbing
    // freshness into the boost decision). The real guard is the end-state assertion
    // (`boostActive === true` from a finite latched reading) below.
    expect(isDeviceObservationStale({
      lastFreshDataMs: Date.now() - STALE_DEVICE_OBSERVATION_MS - 60_000,
    })).toBe(true);
    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedInput({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature: 50,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(planDevice.boostActive).toBe(true);
  });

  it('does not enable temperature boost without a target temperature capability', () => {
    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedInput({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        targets: [],
        currentTemperature: 50,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(planDevice.boostActive).toBe(false);
  });

  it('emits one generic boost transition event when boost becomes active', () => {
    const state = createPlanEngineState();

    buildInitialPlanDevices({
      context: buildContext([steppedInput({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature: 54.9,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    // One generic event, whatever the device boosts on. The unit-bearing detail
    // (°C / %) belongs to the producer that compared the value with the floor.
    expect(logCapture.findEvent('boost_state_changed')).toMatchObject({
      deviceId: 'tank',
      deviceName: 'Water tank',
      active: true,
      previousActive: false,
      boostRequested: true,
      forced: false,
    });
  });

  it('ends boost as soon as the device reaches its floor — no exit-margin hysteresis', () => {
    // Regression for the dropped TEMPERATURE_BOOST_EXIT_MARGIN_C: at 56 °C the device is
    // already at/above its 55 °C floor (it sits inside the former 55–57 °C hysteresis band),
    // so even though boost was active last cycle it ends now. Previously the +2 °C margin
    // kept it active until 57 °C, manufacturing overshoot.
    const state = createPlanEngineState();
    state.boostActiveByDevice.tank = true;

    buildInitialPlanDevices({
      context: buildContext([steppedInput({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature: 56,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(logCapture.findEvent('boost_state_changed')).toMatchObject({
      deviceId: 'tank',
      active: false,
      previousActive: true,
      boostRequested: false,
    });
  });

  it('does not independently shed devices when hourly budget is exhausted without a shedSet decision', () => {
    const state = createPlanEngineState();
    state.hourlyBudgetExhausted = true;

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([inputDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: true },
        controllable: true,
        expectedPowerKw: 1.2,
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(planDevice.plannedState).toBe('keep');
    expect(reasonText(planDevice.reason)).toBe('keep');
  });

  it('tracks EV boost on stepped EV chargers without changing budget exemption', () => {
    const state = createPlanEngineState();

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedInput({
        id: 'charger',
        name: 'Driveway charger',
        deviceClass: 'evcharger',
        objectiveKind: 'ev_soc',
        deviceType: 'onoff',
        targets: [],
        budgetExempt: false,
        evChargingState: 'plugged_in_charging',
        stateOfCharge: stateOfChargeFixture({ percent: 32 }),
        evBoost: { enabled: true, boostBelowPercent: 40 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(boostActiveOf(planDevice)).toBe(true);
    expect(planDevice.budgetExempt).toBe(false);
    expect(state.boostActiveByDevice.charger).toBe(true);
  });

  it('keeps stepped loads on temperature shedding when that is the chosen shed behavior', () => {
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      deviceType: 'temperature',
      selectedStepId: 'max',
      desiredStepId: 'max',
      targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 0.5,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_temperature', temperature: 55, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.shedAction).toBe('set_temperature');
    expect(planDevice.shedTemperature).toBe(55);
    expect(planDevice.releaseShedStepId).toBeNull();
    expect(plannedTargetOf(planDevice)).toBe(55);
    expect(planDevice.desiredStepId).toBe('max');
  });

  it('resolves stepped set_step shed action via the producer cascade when no step id is configured', () => {
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      deviceType: 'temperature',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      desiredStepId: 'max',
      targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
      binaryControl: { on: true },
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 0.5,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.shedAction).toBe('set_step');
    // Producer fills releaseShedStepId from its release cascade (lowest-active step) when
    // shedBehavior.stepId is null. The cap-driven shed path in planSteppedLoad ignores
    // this field, but it must still be present on the materialised triple so the
    // lifecycle-end release executor can read it.
    expect(planDevice.releaseShedStepId).toBe('low');
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('advances past a pending lower stepped shed target during materialization', () => {
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      desiredStepId: 'mid',
      stepCommandPending: true,
      binaryControl: { on: true },
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 3,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('forces a shed stepped load to lowest active step while another device is recovering', () => {
    const state = createPlanEngineState();
    state.shedDecidedMs.gang = Date.now() - 60_000;
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      binaryControl: { on: true },
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 3,
    });
    const recoveringDevice = inputDevice({
      id: 'gang',
      name: 'Hall thermostat',
      binaryControl: { on: false },
      controllable: true,
      currentDrawKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice, recoveringDevice]),
      state,
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('uses measured-power fallback for shed stepped loads without a known current step', () => {
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: undefined,
      desiredStepId: undefined,
      binaryControl: { on: true },
      controllable: true,
      currentDrawKw: 3,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.shedAction).toBe('set_step');
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('commands the rung the shedding planner decided, not one re-derived from the device', () => {
    // The device's own fields point elsewhere — a stale `desiredStepId` of `low`
    // with no pending command — and materialization must not answer from them.
    // Whether to advance past that stale step was decided when the shed was
    // priced (`resolveEffectiveCurrentStepIdForSteppedShedding`); re-deriving it
    // here is how the credited rung and the delivered rung came apart.
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      desiredStepId: 'low',
      stepCommandPending: false,
      binaryControl: { on: true },
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 3,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map([['dev-1', 'mid']]),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.desiredStepId).toBe('mid');
    expect(planDevice.plannedShedStepId).toBe('mid');
  });

  it('falls back to the behaviour floor only when the planner decided no rung', () => {
    // A device the shedding planner did not price a rung for — a shed decided by
    // a later stage. `turn_off` then means what it always meant as a floor: the
    // off step.
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      binaryControl: { on: true },
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 3,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.desiredStepId).toBe('off');
  });

  it('does not let stale restore intent raise the shed target for set_step shedding', () => {
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      selectedStepId: 'low',
      desiredStepId: 'max',
      binaryControl: { on: true },
      controllable: true,
      expectedPowerKw: 1.25,
      currentDrawKw: 1.19,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.shedAction).toBe('set_step');
    expect(isSteppedLoadDevice(planDevice) ? planDevice.selectedStepId : undefined).toBe('low');
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('exposes binaryCommandPending when a pending binary command exists for the device', () => {
    const device = inputDevice({ id: 'dev-1', name: 'Heater', binaryControl: { on: false } });

    const state = createPlanEngineState();
    state.pendingBinaryCommands['dev-1'] = {
      dispatchState: 'accepted',
      desired: true,
      startedMs: Date.now(),
      pendingMs: 90_000,
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: pendingStoreFor(state),
      },
    });

    expect(planDevice.binaryCommandPending).toBe(true);
  });

  it('propagates communicationModel into planned devices', () => {
    const device = steppedInput({
      id: 'dev-1',
      name: 'Cloud Heater',
      communicationModel: 'cloud',
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: 'low' }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.communicationModel).toBe('cloud');
  });

  it('omits binaryCommandPending when no pending binary command exists', () => {
    const device = inputDevice({ id: 'dev-1', name: 'Heater', binaryControl: { on: true } });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.binaryCommandPending).toBeUndefined();
  });

  it('omits binaryCommandPending when pending command is a shed (desired=false)', () => {
    const device = inputDevice({ id: 'dev-1', name: 'Heater', binaryControl: { on: true } });

    const state = createPlanEngineState();
    state.pendingBinaryCommands['dev-1'] = {
      dispatchState: 'accepted',
      desired: false,
      startedMs: Date.now(),
      pendingMs: 90_000,
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: pendingStoreFor(state),
      },
    });

    expect(planDevice.binaryCommandPending).toBeUndefined();
  });

  it('carries the producer-resolved unknown label for a stale binary device', () => {
    // Staleness is folded into the observer's four-valued label at the producer
    // (`toPlanDevice` → `resolveObservedCurrentState`), so a stale binary device
    // arrives with `currentState: 'unknown'`. The planner TRUSTS that label
    // (`planDevices.resolveCurrentState`) — it does not re-derive off/unknown from
    // staleness, which the plan device no longer carries.
    const device = inputDevice({
      id: 'dev-1',
      name: 'Heater',
      binaryControl: { on: false },
      binaryCapabilityId: 'onoff',
      currentState: 'unknown',
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.currentState).toBe('unknown');
  });

  it('detects shed drift for off stepped devices and drives them to the off-step during shortfall', () => {
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      selectedStepId: 'max',
      binaryControl: { on: false }, // OFF at binary level
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 0,
    });

    const context = buildContext([steppedDevice]);
    context.headroomRaw = -1;
    context.headroom = -1; // Shortfall

    const [planDevice] = buildInitialPlanDevices({
      context,
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: true, // Shortfall!
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: 'low' }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.currentState).toBe('off');
    expect(planDevice.plannedState).toBe('shed'); // Should be shed because of shortfall
    expect(planDevice.desiredStepId).toBe('off'); // Should be driven to off-step!
    expect(reasonText(planDevice.reason)).toContain('shortfall');
    // Restore need in reason should be based on low step (1.25kW + 0.23kW buffer = 1.48kW), not max (3kW),
    // and shortfall must not retain the non-off set_step target.
    expect(reasonText(planDevice.reason)).toContain('need 1.48kW');
  });

  it('keeps off-state restore analysis out of the public reason field', () => {
    const device = inputDevice({
      id: 'dev-1',
      name: 'Hall Heater',
      binaryControl: { on: false },
      controllable: true,
      expectedPowerKw: 1,
      currentDrawKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('keep');
    expect(reasonText(planDevice.reason)).toBe('keep');
  });

  it('forces already-shed off stepped devices to keep the off-step during shortfall', () => {
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Water Heater',
      selectedStepId: 'max',
      binaryControl: { on: false },
      controllable: true,
      expectedPowerKw: 3,
      currentDrawKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: true,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: 'low' }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(reasonText(planDevice.reason)).toBe('shed due to capacity');
    expect(planDevice.desiredStepId).toBe('off');
  });

  it('sets desiredStepId=off and expectedPowerKw=lowest-positive-step for a turn_off shed device already at off-step', () => {
    // Device has already arrived at the off step (selectedStepId='off', currentOn=false).
    // The plan must normalize desiredStepId to 'off' (not an intermediate shed step)
    // and set expectedPowerKw to the lowest positive step power (1.25 kW), not zero,
    // so that restore planning uses a realistic power estimate.
    const steppedDevice = steppedInput({
      id: 'dev-1',
      name: 'Tank Heater',
      selectedStepId: 'off',
      binaryControl: { on: false },
      controllable: true,
      expectedPowerKw: 0,
      currentDrawKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.desiredStepId).toBe('off');
    // Restore expectation should be the lowest positive step (low = 1250 W = 1.25 kW), not zero
    expect(planDevice.expectedPowerKw).toBeCloseTo(1.25);
  });

  it('keeps a currently-on device active even when its generic commandability is false', () => {
    // The planner consumes producer-resolved current state and generic
    // commandability only. Commandability gates a future transition; it must not
    // reinterpret an observed-on device as inactive or inspect EV terminology.
    const charger = inputDevice({
      id: 'charger-1',
      name: 'EV Charger',
      binaryCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
      binaryControl: { on: true }, // stale: device still looks 'on' in the snapshot
      controllable: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([charger]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('keep');
  });

  it('does not mark an actively-charging EV as inactive due to unknown expected power', () => {
    // getInactiveReason also returns a reason when expectedPowerSource==='default'.
    // Moving that check before the currentState guard would incorrectly block shedding
    // of a charging EV. Only the physical state block (plugged_out etc.) should pre-empt
    // the off-state guard.
    const charger = inputDevice({
      id: 'charger-1',
      name: 'EV Charger',
      binaryCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_charging',
      expectedPowerSource: 'default',
      binaryControl: { on: true },
      controllable: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([charger]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('keep');
  });

  it('does not mark an EV with undefined evChargingState as inactive when currently on', () => {
    // evChargingState===undefined is ambiguous (capability not yet read). It should not
    // pre-empt the off-state guard for an active device — defer until confirmed off.
    const charger = inputDevice({
      id: 'charger-1',
      name: 'EV Charger',
      binaryCapabilityId: 'evcharger_charging',
      binaryControl: { on: true },
      controllable: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([charger]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: emptyPendingStore,
      },
    });

    expect(planDevice.plannedState).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// Group 1 & 2 & 3: turn_off / turn_on actuation semantics
// These tests lock in the intended shed action selection and step intent rules
// for stepped-load devices. Tests marked it.fails() document desired behavior
// that is not yet implemented.
// ---------------------------------------------------------------------------

const buildTurnOffDeps = (overrides: Partial<PlanDevicesDeps> = {}): PlanDevicesDeps => ({
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  pendingBinaryCommandStore: emptyPendingStore,
  ...overrides,
});

describe('stepped-load turn_off shed action selection (Group 1)', () => {
  // Test 1.1: turn_off is valid for a stepped device that has binary control.
  it('turn_off is a valid shed action for a stepped device with onoff', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      selectedStepId: 'max',
      binaryControl: { on: true },
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
  });

  // Test 1.2: turn_off must be rejected when the device has no binary control.
  // Current: shedAction resolves to 'turn_off' regardless of hasBinaryControl.
  it('turn_off must not be selected as shed action for a stepped device without binary control', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: undefined,
      selectedStepId: 'max',
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).not.toBe('turn_off');
  });
});

describe('stepped-load turn_off: desiredStepId targets lowest step (Group 2)', () => {
  // Test 2.1: turn_off shed must set desiredStepId to the lowest (off) step, not the
  // current step. Current: desiredStepId stays at the current selectedStepId for turn_off.
  it('turn_off shed sets desiredStepId to the lowest step, not the current medium step', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      selectedStepId: 'medium',
      binaryControl: { on: true },
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
    // Lowest step is 'off' (planningPowerW=0); desiredStepId must be 'off', not 'medium'.
    expect(planDevice.desiredStepId).toBe('off');
  });

  // Test 2.2: same assertion when the lowest step is the zero-usage off step.
  it('turn_off shed targets the zero-usage off step when starting from max step', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      selectedStepId: 'max',
      binaryControl: { on: true },
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
    // steppedProfile has 'off' at 0 W — that must be the target for turn_off.
    expect(planDevice.desiredStepId).toBe('off');
  });

  // Test 2.3: device is already at the lowest step — desiredStepId must stay 'off'.
  // This passes because initialDesiredStepId returns the current step ('off') which
  // happens to already be correct. The test guards against a regression that over-corrects.
  it('turn_off shed keeps desiredStepId=off when device is already at the lowest step', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      selectedStepId: 'off',
      binaryControl: { on: false },
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: shedReasonMap([['dev-1', 'shed due to capacity']]),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
    expect(planDevice.desiredStepId).toBe('off');
  });
});

describe('stepped-load turn_on: desiredStepId normalization (Group 3 / planDevices side)', () => {
  // Test 3.4 / Regression 5.2 (planDevices layer): a keep device whose selectedStepId
  // is the off-step must have its desiredStepId normalized to the lowest non-zero step.
  // Current: desiredStepId echoes selectedStepId ('off') because
  // resolveSteppedLoadInitialDesiredStepId just reflects the current step.
  it('restore (keep) normalizes off-step desiredStepId to lowest non-zero step', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      selectedStepId: 'off',
      binaryControl: { on: false },
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.plannedState).toBe('keep');
    // Off-step desiredStepId must be normalized to the lowest non-zero step ('low').
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('preserves runtime stepped restore intent for keep devices while confirmation is still pending', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      binaryControl: { on: true },
      selectedStepId: 'low',
      desiredStepId: 'max',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.plannedState).toBe('keep');
    expect(isSteppedLoadDevice(planDevice) ? planDevice.selectedStepId : undefined).toBe('low');
    expect(planDevice.desiredStepId).toBe('max');
    expect(planDevice.targetStepId).toBe('max');
    expect(planDevice.lastDesiredStepId).toBe('max');
  });

  it('restore (keep) normalizes unknown-step off devices to lowest non-zero step and expected load', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      selectedStepId: undefined,
      desiredStepId: 'max',
      binaryControl: { on: false },
      expectedPowerKw: 3,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.plannedState).toBe('keep');
    expect(planDevice.desiredStepId).toBe('low');
    expect(planDevice.expectedPowerKw).toBeCloseTo(1.25);
  });

  it('leaves stepped restore intent unchanged when no positive restore step exists', () => {
    const device = steppedInput({
      id: 'dev-1',
      binaryCapabilityId: 'onoff',
      binaryControl: { on: false },
      selectedStepId: undefined,
      desiredStepId: undefined,
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'idle', planningPowerW: 0 },
        ],
      },
      expectedPowerKw: 0.7,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.desiredStepId).toBeUndefined();
    expect(planDevice.expectedPowerKw).toBe(0.7);
  });

  // The producer cannot build this device: every rung of `estimatePower` is
  // finiteness-gated, so `expectedPowerKw` is always a finite positive number and
  // "no usable power" is not a state the plan layer can observe. What is still
  // worth pinning is that junk arriving here anyway resolves to 0 rather than
  // propagating — a raw Infinity would poison every headroom sum it reached.
  it('resolves non-finite power fields to 0 rather than propagating them', () => {
    const device = inputDevice({
      id: 'dev-1',
      name: 'Broken heater',
      currentDrawKw: Number.NaN,
      expectedPowerKw: Number.POSITIVE_INFINITY,
      planningPowerKw: Number.NaN,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.expectedPowerKw).toBe(0);
  });

  describe('deferred temperature objective override', () => {
    const tempInputDevice = (
      overrides: Partial<PlanInputDevice>
        & BinaryControlDiscriminantProbe
        & TemperatureDiscriminantProbe
        & FixtureBoostFields
        & { evChargingState?: string; deviceType?: 'temperature' | 'onoff' } = {},
    ) => inputDevice({
      id: 'tank',
      name: 'Water tank',
      deviceType: 'temperature',
      currentTemperature: 45,
      // The atomic facet's target value rides on the narrowed input kind; the
      // targets entry carries only normalization metadata alongside it.
      currentTarget: 50,
      targets: [{ id: 'target_temperature', value: 50, unit: '°C', min: 30, max: 70 }],
      ...overrides,
    });

    it('lifts plannedTarget to the deadline target when it exceeds the mode target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: {
          ...buildContext([tempInputDevice({ deadlineFloorTargetC: 60 })]),
          desiredForMode: { tank: 50 },
          currentHourPriceLevel: { cheap: true, expensive: false },
        },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(plannedTargetOf(planDevice)).toBe(60);
    });

    it('keeps the mode target when it already exceeds the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 60 })]), desiredForMode: { tank: 65 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(plannedTargetOf(planDevice)).toBe(65);
    });

    it('does not double-apply the cheap-hour delta on top of the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 60 })]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          getPriceOptimizationEnabled: () => true,
          getPriceOptimizationSettings: () => ({ tank: { enabled: true, cheapDelta: 2, expensiveDelta: 0 } }),
        },
      });

      // mode 50 + cheap delta 2 = 52; deadline 60 wins. Delta is not stacked on top of 60.
      expect(plannedTargetOf(planDevice)).toBe(60);
    });

    it('lets mode + cheap delta win when the result still exceeds the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: {
          ...buildContext([tempInputDevice({ deadlineFloorTargetC: 56 })]),
          desiredForMode: { tank: 55 },
          currentHourPriceLevel: { cheap: true, expensive: false },
        },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          getPriceOptimizationEnabled: () => true,
          getPriceOptimizationSettings: () => ({ tank: { enabled: true, cheapDelta: 3, expensiveDelta: 0 } }),
        },
      });

      // mode 55 + cheap delta 3 = 58; deadline 56 — mode side already higher, no override.
      expect(plannedTargetOf(planDevice)).toBe(58);
    });

    it('seeds plannedTarget from the deadline target when no mode target is configured', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 58 })]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(plannedTargetOf(planDevice)).toBe(58);
    });

    it('clips the deadline target to the device capability max', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 95 })]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      // capability max is 70 per tempInputDevice fixture.
      expect(plannedTargetOf(planDevice)).toBe(70);
    });

    it('does not override when the device has no deadline floor stamped', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(plannedTargetOf(planDevice)).toBe(50);
    });

    it('shed temperature still wins over the deadline override when shedding via set_temperature', () => {
      const device = tempInputDevice({ binaryControl: { on: true }, deadlineFloorTargetC: 60 });
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([device]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(['tank']),
        shedReasons: shedReasonMap([['tank', 'shed due to capacity']]),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          getShedBehavior: () => ({ action: 'set_temperature', temperature: 40, stepId: null }),
        },
      });

      expect(planDevice.plannedState).toBe('shed');
      expect(plannedTargetOf(planDevice)).toBe(40);
    });
  });

  describe('mode target fallback', () => {
    const tempInputDevice = (
      overrides: Partial<PlanInputDevice>
        & BinaryControlDiscriminantProbe
        & TemperatureDiscriminantProbe
        & FixtureBoostFields
        & { evChargingState?: string; deviceType?: 'temperature' | 'onoff' } = {},
    ) => inputDevice({
      id: 'tank',
      name: 'Water tank',
      deviceType: 'temperature',
      currentTemperature: 45,
      // The atomic facet's target value rides on the narrowed input kind; the
      // targets entry carries only normalization metadata alongside it.
      currentTarget: 50,
      targets: [{ id: 'target_temperature', value: 50, unit: '°C', min: 30, max: 70 }],
      ...overrides,
    });

    it('uses the mode target when present', () => {
      const debugStructured = vi.fn();
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 55 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' },
      });

      expect(plannedTargetOf(planDevice)).toBe(55);
      expect(debugStructured).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target' }),
      );
    });

    it('falls back to the current target capability and emits missing_mode_target', () => {
      const debugStructured = vi.fn();
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' },
      });

      expect(plannedTargetOf(planDevice)).toBe(50);
      expect(debugStructured).toHaveBeenCalledWith({
        event: 'missing_mode_target',
        deviceId: 'tank',
        deviceName: 'Water tank',
        operatingMode: 'home',
      });
    });

    it('combines the current-target fallback with an active deferred objective', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 58 })]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      // currentTarget = 50, deferred = 58 — max wins.
      expect(plannedTargetOf(planDevice)).toBe(58);
    });

    it('does not apply price-opt delta when the seed comes from the current-target fallback', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: {
          ...buildContext([tempInputDevice()]),
          desiredForMode: {},
          currentHourPriceLevel: { cheap: true, expensive: false },
        },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          getPriceOptimizationEnabled: () => true,
          getPriceOptimizationSettings: () => ({ tank: { enabled: true, cheapDelta: 2, expensiveDelta: -1 } }),
          getOperatingMode: () => 'home',
        },
      });

      // currentTarget = 50; no mode target → fallback path. Cheap-hour delta of +2 must NOT
      // apply, so PELS remains a no-op against the existing setpoint.
      expect(plannedTargetOf(planDevice)).toBe(50);
    });

  });

  // Per-device emit-on-first-occurrence + 15-minute heartbeat so a stuck
  // misconfigured device (mode target unset) does not flood the log buffer when
  // the `plan` debug topic is enabled. The old abandon-grace window for
  // transient capability reads is gone: the observer's atomic temperature facet
  // guarantees a finite current target for every temperature device, so the
  // capability-value fallback is total and the only miss left is user config
  // absence.
  describe('missing-mode-target emit throttle', () => {
    const tempDeviceWithValue = (value: number) => inputDevice({
      id: 'tank',
      name: 'Water tank',
      deviceType: 'temperature',
      currentTemperature: 45,
      currentTarget: value,
      targets: [{ id: 'target_temperature', value, unit: '°C', min: 30, max: 70 }],
    });

    it('bounds emit count for 100 consecutive missing-mode cycles via 15-minute heartbeat', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // Drive 100 cycles spaced 1 minute apart so the heartbeat (15 min) emits
      // a bounded number of times.
      const cycleSpacingMs = 60 * 1000;
      const baseMs = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now');
      try {
        for (let cycle = 0; cycle < 100; cycle += 1) {
          dateNowSpy.mockReturnValue(baseMs + cycle * cycleSpacingMs);
          buildInitialPlanDevices({
            context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
            state,
            shedSet: new Set(),
            shedReasons: new Map(),
            shedStepTargets: new Map(),
            guardInShortfall: false,
            deps,
          });
        }
      } finally {
        dateNowSpy.mockRestore();
      }

      const emits = debugStructured.mock.calls.filter(([entry]) => (
        (entry as { event?: string }).event === 'missing_mode_target'
      ));
      // 100 minutes at a 15-minute heartbeat = first emit + 6 heartbeat re-emits = 7.
      expect(emits.length).toBeLessThanOrEqual(7);
      expect(emits.length).toBeGreaterThanOrEqual(6);
    });

    it('clears the throttle when the mode target returns, so the next miss re-emits immediately', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // Phase 1: mode target missing → fallback to the device's own setpoint,
      // emit `missing_mode_target` once.
      buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target' }),
      );

      // Phase 2: mode target configured again → no emit, throttle entry cleared.
      debugStructured.mockClear();
      buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: { tank: 55 } },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(debugStructured).not.toHaveBeenCalled();
      expect(state.modeTargetMissingByDevice.tank).toBeUndefined();

      // Phase 3: mode target disappears again → re-emit immediately because
      // the per-device throttle was cleared on the transition back to fresh.
      buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target' }),
      );
    });

    it('suppresses re-emits inside the throttle window while the mode target stays missing', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };
      const baseMs = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now');

      try {
        dateNowSpy.mockReturnValue(baseMs);
        buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          shedStepTargets: new Map(),
          guardInShortfall: false,
          deps,
        });
        expect(debugStructured).toHaveBeenCalledTimes(1);

        // A cycle 1 s later, still missing → throttled, no new emit.
        debugStructured.mockClear();
        dateNowSpy.mockReturnValue(baseMs + 1000);
        buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          shedStepTargets: new Map(),
          guardInShortfall: false,
          deps,
        });
        expect(debugStructured).not.toHaveBeenCalled();

        // Past the heartbeat interval → one re-emit.
        dateNowSpy.mockReturnValue(baseMs + MISSING_MODE_TARGET_EMIT_INTERVAL_MS + 1000);
        buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          shedStepTargets: new Map(),
          guardInShortfall: false,
          deps,
        });
        expect(debugStructured).toHaveBeenCalledTimes(1);
      } finally {
        dateNowSpy.mockRestore();
      }
    });
  });

  describe('cleanupMissingModeTargetDevices', () => {
    it('deletes tracking entries for devices no longer in the snapshot', () => {
      const state = createPlanEngineState();
      state.modeTargetMissingByDevice['tank'] = { lastEmitAtMs: 1000 };
      state.modeTargetMissingByDevice['ev'] = { lastEmitAtMs: 2000 };

      const removed = cleanupMissingModeTargetDevices(state, new Set(['ev']));

      expect(removed).toBe(true);
      expect(state.modeTargetMissingByDevice.tank).toBeUndefined();
      expect(state.modeTargetMissingByDevice.ev).toBeDefined();
    });

    it('returns false and leaves state untouched when no entries are stale', () => {
      const state = createPlanEngineState();
      state.modeTargetMissingByDevice['tank'] = { lastEmitAtMs: 1000 };

      const removed = cleanupMissingModeTargetDevices(state, ['tank']);

      expect(removed).toBe(false);
      expect(state.modeTargetMissingByDevice.tank).toBeDefined();
    });
  });

  // docs/technical.md:222 — while any other managed device is limited, a stepped device on
  // keep is capped at its lowest non-zero step. Wires through buildInitialPlanDevices to
  // confirm the shedSet-derived flag flows into resolveSteppedKeepDesiredStepId end-to-end.
  describe('stepped keep invariant (shed side)', () => {
    const buildStepped = (overrides = {}) => steppedInput({
      id: 'heater',
      name: 'Water heater',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
      binaryControl: { on: true },
      ...overrides,
    });

    const buildBinary = (id: string) => inputDevice({
      id,
      name: id,
      binaryControl: { on: true },
    });

    it('clamps a stepped keep device to lowest non-zero step when another device is shed', () => {
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped(), buildBinary('thermostat')]),
        state: createPlanEngineState(),
        shedSet: new Set(['thermostat']),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(stepped.id).toBe('heater');
      expect(stepped.plannedState).toBe('keep');
      expect(stepped.desiredStepId).toBe('low');
    });

    it('preserves each admitted boost rung across rebuilds, then releases to the configured step', () => {
      const state = createPlanEngineState();
      const thermostat = buildBinary('thermostat');
      const buildBoostCycle = (selectedStepId: string, currentTemperature: number) => {
        const [stepped] = buildInitialPlanDevices({
          context: buildContext([
            buildStepped({
              deviceType: 'temperature',
              currentTarget: 65,
              targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
              currentTemperature,
              temperatureBoost: { enabled: true, boostBelowC: 55 },
              selectedStepId,
              desiredStepId: 'low',
            }),
            thermostat,
          ]),
          state,
          shedSet: new Set(['thermostat']),
          shedReasons: new Map(),
          shedStepTargets: new Map(),
          guardInShortfall: false,
          deps: defaultDeps,
        });
        return stepped;
      };

      const atMedium = buildBoostCycle('medium', 50);
      expect(atMedium.boostActive).toBe(true);
      expect(atMedium.desiredStepId).toBe('medium');

      const atMax = buildBoostCycle('max', 50);
      expect(atMax.boostActive).toBe(true);
      expect(atMax.desiredStepId).toBe('max');

      const boostEnded = buildBoostCycle('max', 55);
      expect(boostEnded.boostActive).toBe(false);
      expect(boostEnded.desiredStepId).toBe('low');
    });

    it('leaves a stepped keep device alone when shedSet is empty', () => {
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped(), buildBinary('thermostat')]),
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(stepped.desiredStepId).toBe('medium');
    });

    it('does NOT clamp a stepped keep device when the only shed is a surplus-only hold', () => {
      // A pool pump WAITING for solar surplus (surplusOnly, not eligible) is an opt-in
      // posture, not capacity pressure — it must not cap the unrelated stepped heater.
      const pump = buildBinary('pool-pump');
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped(), { ...pump, surplusOnly: true } as typeof pump]),
        state: createPlanEngineState(),
        shedSet: new Set(['pool-pump']),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(stepped.id).toBe('heater');
      expect(stepped.plannedState).toBe('keep');
      expect(stepped.desiredStepId).toBe('medium');
    });

    it('does NOT clamp when the surplus-only hold is release-pending (eligible latched, still off)', () => {
      // The pump was eligible during surplus but its ON never materialized; surplus
      // then vanished, latching `eligible` with `pendingSinceMs` set while it stays
      // off. `resolveSurplusHold` still holds it for solar (not eligible-and-runnable),
      // so it must not count as capacity pressure — the earlier `eligible !== true`
      // proxy missed this release-pending window and clamped the unrelated heater.
      // Off pump (binaryControl.on = false) — its ON never materialized.
      const pump = inputDevice({ id: 'pool-pump', name: 'pool-pump', binaryControl: { on: false }, surplusOnly: true });
      const state = createPlanEngineState();
      state.surplusEligibilityByDevice['pool-pump'] = { eligible: true, pendingSinceMs: 1_000 };
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped(), pump]),
        state,
        shedSet: new Set(['pool-pump']),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(stepped.id).toBe('heater');
      expect(stepped.plannedState).toBe('keep');
      expect(stepped.desiredStepId).toBe('medium');
    });

    it('DOES clamp when a surplusOnly device is genuinely capacity-shed (fresh shedReason)', () => {
      // Discriminator mirror of the executor: a surplusOnly device with a FRESH
      // capacity shedReason is real pressure and still bounds the stepped device.
      const pump = buildBinary('pool-pump');
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped(), { ...pump, surplusOnly: true } as typeof pump]),
        state: createPlanEngineState(),
        shedSet: new Set(['pool-pump']),
        shedReasons: shedReasonMap([['pool-pump', 'shed due to capacity']]),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(stepped.desiredStepId).toBe('low');
    });

    it('ignores phantom underspecified set_step shed entries when deciding the invariant', () => {
      // Device B is in shedSet with set_step shed action, but it's already at the lowest active
      // step — resolveSteppedLoadDirectShedStepId returns the same step (no change). Mirrors the
      // phantom case that hasExecutableShedDevices filters out of keep-invariant posture.
      const keepStepped = buildStepped({ id: 'heater' });
      const phantomStepped = steppedInput({
        id: 'phantom',
        name: 'phantom',
        selectedStepId: 'low',
        desiredStepId: 'low',
        binaryControl: { on: true },
      });

      const [stepped] = buildInitialPlanDevices({
        context: buildContext([keepStepped, phantomStepped]),
        state: createPlanEngineState(),
        shedSet: new Set(['phantom']),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        },
      });

      expect(stepped.id).toBe('heater');
      expect(stepped.plannedState).toBe('keep');
      // Phantom shedSet entry doesn't count as posture, so the keep device stays at medium.
      expect(stepped.desiredStepId).toBe('medium');
    });

    it('does not trigger the invariant when the only shed device is the stepped device itself', () => {
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped()]),
        state: createPlanEngineState(),
        shedSet: new Set(['heater']),
        shedReasons: new Map(),
        shedStepTargets: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      // Self-shed: plannedState becomes shed, not keep — the invariant clamp doesn't apply.
      expect(stepped.plannedState).toBe('shed');
    });
  });
});
