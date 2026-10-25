// SDK-boundary inputs (stored source prices, measured device state and clock)
// drive the real price owner, task bridge, allocator, recorder and admission.
// Like deferredObjectiveColdStartSdkE2E, the device fixture is the projection of
// those readings into the planning lane; no allocator or frozen-read result is
// mocked. Unchanged progress readings deliberately leave work outstanding so
// the test observes the schedule gate rather than early target satisfaction.
import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PriceService from '../../lib/price/priceService';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { FLOW_PRICES_TODAY, PRICE_SCHEME } from '../../lib/utils/settingsKeys';
import { objectiveRosterFor } from '../utils/objectiveRoster';
import type { DeferredObjectiveSettingsKind } from '../../packages/contracts/src/deferredObjectiveSettings';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import { normalizeDeferredObjectiveActivePlans } from '../../lib/objectives/deferredObjectives/activePlanSettings';
import { EnergyTaskDeliveryTracker } from '../../lib/objectives/deferredObjectives/energyDelivery';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { type MeteredPlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { buildFixtureDiagnostics } from '../helpers/taskEvaluationFixture';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { createInMemoryPriceCache } from '../helpers/priceCacheForTests';
import { noHomeyEnergyPrices, noHomeyWebApi } from '../helpers/homeyWebApiStub';
import {
  createMemoryEnergyDeliveryStore,
  everyReadingLive,
  noDeviceExclusion,
  noStallEvidence,
} from '../helpers/deferredObjectiveWiringFixtures';
import {
  fixtureControlPosture,
  withFixtureResidualKw,
  withMaterializedEvPlugState,
} from '../utils/planTestUtils';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { testLogger } from '../utils/testLogger';

const MINUTE_MS = 60_000;
const QUARTER_MS = 15 * MINUTE_MS;
const START_MS = Date.parse('2026-10-25T10:00:00Z');
const DEADLINE_MS = START_MS + 3 * 60 * MINUTE_MS;
const DEVICE_ID = 'quarter-task-device';
const TASK_KINDS: DeferredObjectiveSettingsKind[] = ['energy', 'temperature', 'ev_soc'];

const buildDevice = (
  kind: DeferredObjectiveSettingsKind,
  nowMs: number,
): MeteredPlanInputDevice & { thermalDirection: 'heating' } => (
  withBinaryDiscriminant(withMaterializedEvPlugState(withFixtureResidualKw({
    id: DEVICE_ID,
    name: 'Quarter-hour device',
    available: true,
    isBatteryOrSolar: false, starvationSupported: true, surplusTracking: false,
    currentDrawKw: 0,
    expectedPowerKw: 2,
    expectedPowerSource: 'measured-peak',
    targets: kind === 'temperature'
      ? [{ id: 'target_temperature', value: 42, unit: 'C', min: 0, max: 95, step: 0.5 }]
      : [],
    binaryCapabilityId: kind === 'ev_soc' ? 'evcharger_charging' : 'onoff',
    binaryControl: { on: false },
    currentOn: false,
    control: fixtureControlPosture({ controllable: false }),
    deviceType: kind === 'temperature' ? 'temperature' : 'onoff',
    thermalDirection: 'heating',
    controlModel: 'stepped_load',
    steppedLoadProfile: {
      steps: [{ id: 'off', planningPowerW: 0 }, { id: 'run', planningPowerW: 2000 }],
    },
    isEvCharger: kind === 'ev_soc',
    evChargingState: 'plugged_in_paused',
    lastFreshDataMs: nowMs,
    ...(kind === 'temperature' ? { currentTemperature: 40 } : {}),
    ...(kind === 'ev_soc' ? { stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: nowMs }) } : {}),
  }))) as MeteredPlanInputDevice & { thermalDirection: 'heating' }
);

// A persisted learned rate of 0.5 kWh per degree/percent makes each kind ask
// for the same 1 kWh: two degrees, two percent, or an explicit 1 kWh target.
const learnedProfile = (nowMs: number): PowerTrackerState => ({
  objectiveProfiles: {
    [DEVICE_ID]: {
      updatedAtMs: nowMs,
      lastSample: { observedAtMs: nowMs, value: 40 },
      kwhPerUnit: {
        sampleCount: 8, mean: 0.5, m2: 0, min: 0.5, max: 0.5,
        confidence: 'high', lastUpdatedMs: nowMs,
      },
      acceptedSamples: 8,
      rejectedSamples: 0,
    },
  },
});

const createScenario = (kind: DeferredObjectiveSettingsKind) => {
  const cache = createInMemoryPriceCache();
  const service = new PriceService(
    mockHomeyInstance as unknown as Homey.App['homey'],
    { structuredLog: testLogger },
    () => 'UTC',
    noHomeyEnergyPrices,
    createPriceDataStore(mockHomeyInstance.settings, cache),
    () => ({}),
    noHomeyWebApi,
  );
  const publishPrices = (cheapQuarters: readonly number[]): void => {
    cache.write(FLOW_PRICES_TODAY, {
      dateKey: '2026-10-25',
      pricesByHour: {},
      pricesByPeriod: Array.from({ length: 12 }, (_, index) => ({
        startsAt: new Date(START_MS + index * QUARTER_MS).toISOString(),
        durationMinutes: 15,
        totalPrice: cheapQuarters.includes(index) ? 1 : 100,
      })),
      updatedAt: new Date().toISOString(),
    });
  };
  publishPrices([0, 2]);
  const targets = {
    energy: { targetEnergyKWh: 1 }, temperature: { targetTemperatureC: 42 }, ev_soc: { targetPercent: 42 },
  };
  const target = targets[kind];
  const settings = objectiveRosterFor({
    objectivesByDeviceId: {
      [DEVICE_ID]: { enabled: true, kind, enforcement: 'soft', deadlineAtMs: DEADLINE_MS, ...target },
    },
  });
  const energyStore = createMemoryEnergyDeliveryStore();
  let energyTracker = new EnergyTaskDeliveryTracker(energyStore, everyReadingLive);
  let persisted: unknown;
  const createRecorder = () => new DeferredObjectiveActivePlanRecorder({
    load: () => persisted === undefined ? null : normalizeDeferredObjectiveActivePlans(persisted),
    save: (plans) => { persisted = JSON.parse(JSON.stringify(plans)); },
  });
  let recorder = createRecorder();

  const cycle = (minutes: number) => {
    const nowMs = START_MS + minutes * MINUTE_MS;
    vi.setSystemTime(nowMs);
    const device = buildDevice(kind, nowMs);
    energyTracker.observe([device], settings, nowMs);
    const diagnostics = buildFixtureDiagnostics({
      hasSolarProduction: false,
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      hasObservedTask: () => false,
      isReservationSuppressed: () => false,
      getDeliveredEnergyKWh: energyTracker.getDeliveredKWh,
      getPrioritiesForDevices: createFixturePriorityQuery([device]),
      powerLimits: capacityOnlyPowerLimits(100),
      nowMs,
      timeZone: 'UTC',
      devices: [device],
      settings,
      powerTracker: learnedProfile(nowMs),
      dailyBudgetSnapshot: null,
      buildPriceHorizon: (startMs, endMs) => service.buildPriceHorizon(startMs, endMs),
      priceOptimizationEnabled: true,
      activePlans: recorder.getActivePlansSnapshot(),
    });
    recorder.observe(diagnostics, nowMs);
    recorder.flushIfDirty();
    const [diagnostic] = diagnostics;
    const decision = diagnostic
      ? applyDeferredObjectiveAdmission([diagnostic.evaluation], [device]).get(DEVICE_ID)
      : undefined;
    return { diagnostic, decision, saved: recorder.getActivePlansSnapshot().plansByDeviceId[DEVICE_ID] };
  };

  return {
    cycle,
    publishPrices,
    clearPrices: () => { cache.write(FLOW_PRICES_TODAY, null); },
    restart: () => {
      recorder.flushIfDirty();
      energyTracker.flushIfDirty();
      recorder = createRecorder();
      energyTracker = new EnergyTaskDeliveryTracker(energyStore, everyReadingLive);
    },
  };
};

describe('native-quarter Smart tasks through the SDK inputs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(START_MS);
    resetMockHomey();
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
  });

  afterEach(() => { vi.useRealTimers(); });

  it.each(TASK_KINDS)('%s follows separated cheap quarters, survives restart and settles only at :58', (kind) => {
    const scenario = createScenario(kind);
    const first = scenario.cycle(0);
    expect(first.diagnostic?.horizonPlan?.status).toBe('on_track');
    expect(first.decision?.kind).toBe('planned');
    const original = first.saved?.latest;
    expect(original?.hours.map(({ startsAtMs, endsAtMs, plannedKWh }) => ({ startsAtMs, endsAtMs, plannedKWh })))
      .toEqual([
        { startsAtMs: START_MS, endsAtMs: START_MS + QUARTER_MS, plannedKWh: 0.5 },
        { startsAtMs: START_MS + 2 * QUARTER_MS, endsAtMs: START_MS + 3 * QUARTER_MS, plannedKWh: 0.5 },
      ]);

    // New prices prefer different quarters, but an ordinary refresh does not
    // replace a commitment between hourly settles.
    scenario.publishPrices([1, 3, 4]);
    expect(scenario.cycle(14.999).decision?.kind).toBe('planned');
    const gap = scenario.cycle(15);
    expect(gap.decision?.kind).toBe('idle');
    expect(gap.diagnostic?.horizonPlan?.frozenRead).toBe(true);
    expect(scenario.cycle(29.999).decision?.kind).toBe('idle');
    expect(scenario.cycle(30).decision?.kind).toBe('planned');
    scenario.cycle(35);
    scenario.restart();
    const restarted = scenario.cycle(36);
    expect(restarted.decision?.kind).toBe('planned');
    expect(restarted.diagnostic?.horizonPlan?.frozenRead).toBe(true);
    expect(restarted.saved?.latest?.hours).toEqual(original?.hours);

    // The last booked quarter ending does not create a new quarter-hour settle.
    const afterLastBooking = scenario.cycle(45);
    expect(afterLastBooking.decision?.kind).toBe('idle');
    expect(afterLastBooking.diagnostic?.horizonPlan?.frozenRead).toBe(true);
    expect(afterLastBooking.saved?.latest?.revision).toBe(original?.revision);
    expect(scenario.cycle(57).saved?.latest?.revision).toBe(original?.revision);
    const settled = scenario.cycle(58);
    expect(settled.diagnostic?.horizonPlan?.frozenRead).not.toBe(true);
    expect(settled.saved?.latest?.revision).toBeGreaterThan(original?.revision ?? 0);
    expect(settled.saved?.latest?.revisedAtMs).toBe(START_MS + 58 * MINUTE_MS);
    expect(scenario.cycle(59).saved?.latest?.revision).toBe(settled.saved?.latest?.revision);
  });

  it('keeps the saved quarter boundaries when the native source temporarily disappears', () => {
    const scenario = createScenario('energy');
    const original = scenario.cycle(0).saved?.latest;
    scenario.clearPrices();
    expect(scenario.cycle(15).decision?.kind).toBe('idle');
    const cheap = scenario.cycle(30);
    expect(cheap.decision?.kind).toBe('planned');
    expect(cheap.diagnostic?.horizonPlan?.frozenRead).toBe(true);
    expect(scenario.cycle(45).decision?.kind).toBe('idle');
    const missedSettle = scenario.cycle(58);
    expect(missedSettle.diagnostic?.horizonPlan?.frozenRead).toBe(true);
    expect(missedSettle.saved?.latest?.hours).toEqual(original?.hours);
    expect(missedSettle.saved?.latest?.revision).toBe(original?.revision);
  });
});
