// Integration test LOCKING that a managed, non-controllable, NON-TEMPERATURE solar
// device is EXCLUDED from every control path while still rising into the planner's
// device set (managed observe-only), AND that its POSITIVE production is NEVER counted
// as consumption — not as controlled load, not as background/uncontrolled load, and not
// in the per-device consumption buckets (diagnostics-as-load).
//
// Drives the REAL planner prep (`buildInitialPlanDevices`), the REAL surplus-absorb
// allocator (`resolveSurplusEligibility`), the REAL controlled/uncontrolled split
// (`sumControlledUsageKw`/`splitControlledUsageKw`), the REAL shed candidate builder
// (`buildSheddingCandidates`), the REAL starvation eligibility
// (`buildDeviceDiagnosticsObservations`), and the REAL whole-home sample ingest
// (`recordPowerSampleForApp`) with a synthetic solar fixture (class:'solarpanel',
// managed:true, controllable:false). Nothing internal is mocked.
import { describe, expect, it, vi } from 'vitest';
import { buildInitialPlanDevices } from '../../lib/plan/planDevices';
import type { PlanDevicesDeps } from '../../lib/plan/planDevices';
import { resolveSurplusEligibility } from '../../lib/plan/planSurplusAbsorb';
import { sumControlledUsageKw, splitControlledUsageKw, sumBudgetExemptProjectedUsageKw } from '../../lib/plan/planUsage';
import { buildSheddingCandidates } from '../../lib/plan/shedding/candidates';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { recordPowerSampleForApp } from '../../lib/power/sampleIngest';
import { buildDeviceDiagnosticsObservations } from '../../lib/plan/planDiagnostics';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { RestorePlanResult } from '../../lib/plan/restore';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { withHeadroomCurrentOn } from '../../lib/plan/planHeadroomSupport';
import type { SplitControlledUsage, SumBudgetExemptUsage } from '../../lib/power/sampleIngest';

// Mirror the production wiring in `setup/powerSamplePipeline.ts`: raw transport
// snapshots go through `withHeadroomCurrentOn` — the producer boundary that
// resolves `currentDrawKw` — before the usage math sees them.
const splitControlledUsage: SplitControlledUsage = (params) => splitControlledUsageKw({
  ...params,
  devices: params.devices.map(withHeadroomCurrentOn),
});
const sumBudgetExemptUsage: SumBudgetExemptUsage = (devices) => (
  sumBudgetExemptProjectedUsageKw(devices.map(withHeadroomCurrentOn))
);


const SOLAR_ID = 'solar';
const HEATER_ID = 'heater';

// A managed observe-only solar device, exactly as the producer stamps it: managed,
// NON-controllable, class:'solarpanel', NO temperature target / control capability.
const solarInputDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice =>
  buildPlanInputDevice({
    id: SOLAR_ID,
    expectedPowerKw: 1,
    name: 'Solar Panel',
    deviceClass: 'solarpanel',
    deviceType: 'onoff',
    managed: true,
    controllable: false,
    binaryCapabilityId: undefined,
    targets: [],
    measuredPowerKw: 3.0, // producing +3.0 kW (POSITIVE)
    ...overrides,
  });

const heaterInputDevice = (): PlanInputDevice =>
  buildPlanInputDevice({
    id: HEATER_ID,
    name: 'Heater',
    deviceClass: 'heater',
    deviceType: 'temperature',
    managed: true,
    controllable: true,
    expectedPowerKw: 1.5,
    measuredPowerKw: 1.5,
    currentTemperature: 19,
    targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  });

const buildContext = (devices: PlanInputDevice[], overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices,
  desiredForMode: { [HEATER_ID]: 21 },
  total: 3,
  planningTotalKw: 3,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  hourBucketKey: '2025-01-01T00',
  softLimit: 2,
  capacitySoftLimit: 2,
  dailySoftLimit: null,
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
  ...overrides,
});

// A real epoch, not 0: `nowTs` is `Date.now()` in production and now dates the
// ceiling shortfall's recent-shed window.
const FIXTURE_NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

const emptyRestoreResult: RestorePlanResult = {
  planDevices: [],
  stateUpdates: { swapByDevice: {} },
  restoredThisCycle: new Set<string>(),
  headroomReserves: [],
  availableHeadroom: 1,
  capacityAvailableKw: 1,
  budgetAvailableKw: null,
  restoredOneThisCycle: false,
  inCooldown: false,
  inRestoreCooldown: false,
  activeOvershoot: false,
  restoreCooldownSeconds: 0,
  shedCooldownRemainingSec: null,
  shedCooldownStartedAtMs: null,
  shedCooldownTotalSec: null,
  restoreCooldownRemainingSec: null,
  restoreCooldownStartedAtMs: null,
  restoreCooldownTotalSec: null,
  inShedWindow: false,
  inStartupStabilization: false,
  nowTs: FIXTURE_NOW_MS,
  restoreCooldownMs: 60 * 1000,
  lastRestoreCooldownBumpMs: null,
  restoreCooldownPreview: null,
};

const defaultDeps: PlanDevicesDeps = {
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
};

describe('solar device as managed observe-only — control-path exclusion lock', () => {
  it('rides the planner device set but plans only "keep" with NO target', () => {
    const planDevices = buildInitialPlanDevices({
      context: buildContext([solarInputDevice()]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    const solar = planDevices.find((d) => d.id === SOLAR_ID);
    expect(solar).toBeDefined();
    expect(solar?.plannedState).toBe('keep');
    expect(solar?.controllable).toBe(false);
    expect(isTemperaturePlanDevice(solar!)).toBe(false);
  });

  it('is never a shed candidate even under capacity overshoot (controllable:false filtered out)', () => {
    const context = buildContext([solarInputDevice(), heaterInputDevice()]);
    const { candidates } = buildSheddingCandidates({
      devices: context.devices,
      needed: 5,
      limitSource: 'capacity',
      total: context.total,
      capacitySoftLimit: context.capacitySoftLimit,
      state: createPlanEngineState(),
      deps: {
        capacityGuard: undefined,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 100,
        pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
        log: () => undefined,
      },
    });
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).not.toContain(SOLAR_ID);
    expect(candidateIds).toContain(HEATER_ID); // exclusion isn't vacuous
  });

  it('is never surplus-absorb eligible (no temperature-boost target) even with export available', () => {
    const state = createPlanEngineState();
    resolveSurplusEligibility({
      devices: [solarInputDevice()],
      state,
      signedNetKw: -3,
      getConfig: () => ({ surplusWilling: true, surplusDelta: 2 }),
      getPriority: () => 1,
      nowTs: Date.UTC(2025, 0, 1, 12, 0, 0),
    });
    expect(state.surplusEligibilityByDevice[SOLAR_ID]).toBeUndefined();
  });

  it('its POSITIVE production is excluded from controlled AND background/uncontrolled load accounting', () => {
    const devices = [
      // Solar producing +3.0 kW. controllable:false → never controlled usage.
      { id: SOLAR_ID, controllable: false, plannedState: 'keep' as const, currentDrawKw: 3.0, expectedPowerKw: 1 },
      { id: HEATER_ID, controllable: true, plannedState: 'keep' as const, currentDrawKw: 1.5, expectedPowerKw: 1 },
    ];
    // Only the heater's 1.5 kW is controlled usage; the solar's +3.0 kW is NOT.
    const controlledKw = sumControlledUsageKw(devices as Parameters<typeof sumControlledUsageKw>[0]);
    expect(controlledKw).toBeCloseTo(1.5, 5);

    // In the split, uncontrolled is the top-down residual (totalKw − controlled). With a
    // 1.5 kW net household total, the solar production does NOT inflate the background
    // bucket to 3.0+ — it is bounded by the (net) total, proving PV production is never
    // summed in as a background load.
    const { controlledKw: split, uncontrolledKw } = splitControlledUsageKw({
      devices: devices as Parameters<typeof splitControlledUsageKw>[0]['devices'],
      totalKw: 1.5, // net household: heater only (solar self-consumed/exported, not a load)
    });
    expect(split).toBeCloseTo(1.5, 5);
    expect(uncontrolledKw).toBeCloseTo(0, 5); // NOT 3.0 — PV production is not background load
  });

  it('is never starvation-eligible (fails the controllable:true + temperature requirement)', () => {
    const context = buildContext([solarInputDevice({ currentDrawKw: 3.0 })]);
    const planDevices = buildInitialPlanDevices({
      context,
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });
    const observations = buildDeviceDiagnosticsObservations({
      context,
      planDevices,
      restoreResult: emptyRestoreResult,
      priceOptimizationEnabled: false,
      priceOptimizationSettings: {},
      getObservationStale: () => false,
    });
    const solarObservation = observations.find((o) => o.deviceId === SOLAR_ID);
    expect(solarObservation?.eligibleForStarvation).toBe(false);
    expect(solarObservation?.countingCause).toBeNull();
  });

  it('PV production is NEVER recorded into the per-device consumption buckets (diagnostics-as-load)', async () => {
    // Drive the REAL whole-home sample ingest twice (so the per-device energy bucket
    // accumulates from the previous fresh sample). A solar device producing +3000 W and
    // a normal heater drawing 1500 W are both in the snapshot with FRESH measured power.
    // The solar device must NOT appear in `lastDevicePowerWById` / `deviceBuckets`; the
    // heater MUST.
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = (nowMs: number) => ([
      {
        id: SOLAR_ID, name: 'Solar Panel', targets: [], deviceClass: 'solarpanel',
        expectedPowerKw: 1,
        measuredPowerKw: 3.0, measuredPowerObservedAtMs: nowMs, controllable: false,
      },
      {
        id: HEATER_ID, name: 'Heater', targets: [], deviceClass: 'heater',
        expectedPowerKw: 1,
        measuredPowerKw: 1.5, measuredPowerObservedAtMs: nowMs, controllable: true,
      },
    ]);

    const sample = async (nowMs: number): Promise<void> => {
      await recordPowerSampleForApp({
        currentPowerW: 1500,
        nowMs,
        capacitySettings: { limitKw: 10, marginKw: 0 },
        // The harness type expects a no-arg getter; close over the per-call nowMs.
        getLatestTargetSnapshot: () => getLatestTargetSnapshot(nowMs) as never,
        powerTracker: tracker,
        splitControlledUsage,
        sumBudgetExemptUsage,
        updateObjectiveProfiles: ({ state }) => state,
        schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
        saveState: (next) => { tracker = next; },
      });
    };

    await sample(start);
    await sample(start + 30 * 1000); // 30 s later, still fresh

    // The per-device snapshot map: solar EXCLUDED, heater PRESENT.
    expect(tracker.lastDevicePowerWById?.[SOLAR_ID]).toBeUndefined();
    expect(tracker.lastDevicePowerWById?.[HEATER_ID]).toBeCloseTo(1500, 0);
    // The accumulated per-device energy buckets: solar has NO bucket; heater does.
    expect(tracker.deviceBuckets?.[SOLAR_ID]).toBeUndefined();
    expect(tracker.deviceBuckets?.[HEATER_ID]).toBeDefined();
  });
});
