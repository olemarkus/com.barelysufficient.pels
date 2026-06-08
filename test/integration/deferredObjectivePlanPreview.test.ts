import { describe, expect, it } from 'vitest';
import {
  buildDeferredObjectiveDiagnostics as buildDeferredObjectiveDiagnosticsRaw,
  DeferredObjectiveActivePlanRecorder,
  previewDeferredObjectivePlan as previewDeferredObjectivePlanRaw,
  resolveDeferredObjectiveDeadline,
  type DeferredObjectivePlanPreviewCandidate,
} from '../../lib/objectives/deferredObjectives';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';
import {
  buildHoursFromHorizonPlan,
  resolveProjectedFinishAtMs,
} from '../../lib/objectives/deferredObjectives/activePlanSchedule';
import { buildDeferredObjectivePolicyWindowPrices } from '../../lib/objectives/deferredObjectives/policyHorizon';
import type { ActivePlanPersistDeps } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import type { DeferredObjectiveSettingsV1 } from '../../lib/objectives/deferredObjectives/settings';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type {
  DeferredObjectiveActivePlansV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 17, 0, 0);

// ── Fixtures (mirroring test/deferredObjectiveDiagnostics.test.ts so the
// preview is exercised against the same device/profile/snapshot shapes the
// live diagnostic path uses) ────────────────────────────────────────────────

const buildEvDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'ev-1',
  name: 'Driveway EV',
  targets: [],
  binaryControl: { on: false },
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in_paused',
  stateOfCharge: { percent: 40, status: 'fresh', observedAtMs: NOW_MS },
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1000 },
      { id: 'high', planningPowerW: 2000 },
    ],
  },
  ...overrides,
});

const buildTemperatureDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'heater-1',
  name: 'Connected 300',
  targets: [{ id: 'target_temperature', value: 55, unit: 'C', min: 0, max: 95, step: 0.5 }],
  binaryControl: { on: false },
  deviceType: 'temperature',
  controlModel: 'stepped_load',
  currentTemperature: 55,
  lastFreshDataMs: NOW_MS,
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'heat', planningPowerW: 3000 },
    ],
  },
  ...overrides,
});

const resolveDeadlineAtMsFor = (deadlineLocalTime: string, nowMs: number = NOW_MS): number => {
  const resolution = resolveDeferredObjectiveDeadline({ nowMs, timeZone: 'UTC', deadlineLocalTime });
  if (resolution.deadlineAtMs === null) throw new Error('Failed to resolve test deadline');
  return resolution.deadlineAtMs;
};

const buildEvPowerTracker = (overrides: Partial<PowerTrackerState> = {}): PowerTrackerState => ({
  objectiveProfiles: {
    'ev-1': {
      kind: 'ev_soc',
      updatedAtMs: NOW_MS,
      lastSample: { observedAtMs: NOW_MS, value: 40, unit: 'percent' },
      kwhPerUnit: {
        sampleCount: 4, mean: 0.2, m2: 0, min: 0.2, max: 0.2, confidence: 'medium', lastUpdatedMs: NOW_MS,
      },
      acceptedSamples: 4,
      rejectedSamples: 0,
    },
  },
  ...overrides,
} as PowerTrackerState);

const buildTemperaturePowerTracker = (overrides: Partial<PowerTrackerState> = {}): PowerTrackerState => ({
  objectiveProfiles: {
    'heater-1': {
      kind: 'temperature',
      updatedAtMs: NOW_MS,
      lastSample: { observedAtMs: NOW_MS, value: 55, unit: 'degree_c' },
      kwhPerUnit: {
        sampleCount: 6, mean: 0.8, m2: 0, min: 0.7, max: 0.9, confidence: 'high', lastUpdatedMs: NOW_MS,
      },
      acceptedSamples: 6,
      rejectedSamples: 0,
    },
  },
  ...overrides,
} as PowerTrackerState);

const buildDay = (params: {
  dateKey: string;
  startMs: number;
  currentBucketIndex: number;
  prices?: number[];
}): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: 24 }, (_, index) => new Date(params.startMs + index * HOUR_MS).toISOString());
  const prices = params.prices ?? Array.from({ length: 24 }, (_, index) => index);
  return {
    dateKey: params.dateKey,
    timeZone: 'UTC',
    nowUtc: new Date(NOW_MS).toISOString(),
    dayStartUtc: new Date(params.startMs).toISOString(),
    currentBucketIndex: params.currentBucketIndex,
    budget: { enabled: true, dailyBudgetKWh: 20, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0, allowedNowKWh: 0, remainingKWh: 20, deviationKWh: 0,
      exceeded: false, frozen: false, confidence: 1, priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, index) => `${String(index).padStart(2, '0')}:00`),
      plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
      plannedKWh: Array.from({ length: 24 }, () => 1),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.2),
      plannedControlledKWh: Array.from({ length: 24 }, () => 0),
      actualKWh: Array.from({ length: 24 }, () => 0),
      actualControlledKWh: Array.from({ length: 24 }, () => null),
      actualUncontrolledKWh: Array.from({ length: 24 }, () => null),
      allowedCumKWh: Array.from({ length: 24 }, (_, index) => (index + 1) * 2),
      price: prices,
      priceFactor: prices.map((price) => (price <= 10 ? 1.2 : 0.8)),
    },
  };
};

const buildSnapshot = (params: { prices?: number[] } = {}): DailyBudgetUiPayload => {
  const today = buildDay({
    dateKey: '2026-01-01',
    startMs: Date.UTC(2026, 0, 1, 0),
    currentBucketIndex: new Date(NOW_MS).getUTCHours(),
    prices: params.prices,
  });
  const tomorrow = buildDay({
    dateKey: '2026-01-02',
    startMs: Date.UTC(2026, 0, 2, 0),
    currentBucketIndex: 0,
    prices: params.prices,
  });
  return {
    days: { [today.dateKey]: today, [tomorrow.dateKey]: tomorrow },
    todayKey: '2026-01-01',
    tomorrowKey: '2026-01-02',
  };
};

// Derive a price-layer `CombinedPricesV2` from a daily-budget snapshot so the
// allocation horizon (which now reads the price layer directly) sees the same
// per-hour prices the snapshot carries. UTC fixtures ⇒ each bucket start is
// already hour-aligned, so the derived hours map one-to-one onto the snapshot.
const combinedFromSnapshot = (snapshot: DailyBudgetUiPayload | null): CombinedPricesV2 | null => {
  if (!snapshot) return null;
  const days: CombinedPricesV2['days'] = {};
  for (const [dateKey, day] of Object.entries(snapshot.days)) {
    const hours: CombinedPriceEntry[] = day.buckets.startUtc.map((startsAt, index) => ({
      startsAt,
      total: day.buckets.price[index],
      isCheap: false,
      isExpensive: false,
    }));
    days[dateKey] = { hours };
  }
  return {
    version: 2,
    days,
    avgPrice: 0,
    lowThreshold: 0,
    highThreshold: 0,
    priceScheme: 'norway',
    priceUnit: 'øre/kWh',
  };
};

// Wrappers inject the price-layer `combinedPrices` derived from the snapshot the
// test already supplies, so the preview / diagnostic allocation path sees the
// same prices it used to read off the snapshot's buckets.
const priceHorizonBuilderFor = (snapshot: DailyBudgetUiPayload | null) => {
  const combined = combinedFromSnapshot(snapshot);
  return (nowMs: number, deadlineAtMs: number) => buildPriceHorizonFromCombined(combined, nowMs, deadlineAtMs);
};

const previewDeferredObjectivePlan = (
  params: Omit<Parameters<typeof previewDeferredObjectivePlanRaw>[0], 'buildPriceHorizon'>,
): ReturnType<typeof previewDeferredObjectivePlanRaw> => previewDeferredObjectivePlanRaw({
  ...params,
  buildPriceHorizon: priceHorizonBuilderFor(params.dailyBudgetSnapshot),
});

const buildDeferredObjectiveDiagnostics = (
  params: Omit<Parameters<typeof buildDeferredObjectiveDiagnosticsRaw>[0], 'buildPriceHorizon'>,
): ReturnType<typeof buildDeferredObjectiveDiagnosticsRaw> => buildDeferredObjectiveDiagnosticsRaw({
  ...params,
  buildPriceHorizon: priceHorizonBuilderFor(params.dailyBudgetSnapshot),
});

const buildRecorder = (): {
  recorder: DeferredObjectiveActivePlanRecorder;
  saved: () => DeferredObjectiveActivePlansV1 | null;
} => {
  let saved: DeferredObjectiveActivePlansV1 | null = null;
  const deps: ActivePlanPersistDeps = {
    load: () => null,
    save: (next) => { saved = next; },
  };
  return { recorder: new DeferredObjectiveActivePlanRecorder(deps), saved: () => saved };
};

// Builds a one-objective settings object for the live diagnostic path.
const buildSettings = (params: {
  deviceId: string;
  candidate: DeferredObjectivePlanPreviewCandidate;
}): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: {
    [params.deviceId]: { ...params.candidate, enabled: true },
  },
});

type PreviewContext = {
  device: PlanInputDevice | undefined;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
  hardCapKw: number | null;
  // Optional override for the price-RATE label fed into the preview. Defaults
  // to "øre/kWh" (the Norway scheme) so most cases exercise the rate→amount
  // conversion (costUnit must come back "øre").
  priceRateLabel?: string;
};

const runPreview = (params: {
  deviceId: string;
  candidate: DeferredObjectivePlanPreviewCandidate;
  ctx: PreviewContext;
}) => previewDeferredObjectivePlan({
  nowMs: NOW_MS,
  timeZone: 'UTC',
  deviceId: params.deviceId,
  candidate: params.candidate,
  device: params.ctx.device,
  powerTracker: params.ctx.powerTracker,
  dailyBudgetSnapshot: params.ctx.dailyBudgetSnapshot,
  priceOptimizationEnabled: params.ctx.priceOptimizationEnabled,
  hardCapKw: params.ctx.hardCapKw,
  priceRateLabel: params.ctx.priceRateLabel ?? 'øre/kWh',
});

// Deadlines chosen against NOW_MS (2026-01-01 17:00 UTC) to land each planner
// verdict deterministically — verified via the diagnostic path:
//   FAR  (tomorrow 23:00) → plenty of slack → on_track
//   NEAR (today 21:00)    → inside the 1h deadline reserve → at_risk
//   TIGHT(today 18:30)    → not enough time/capacity for the energy → cannot_meet
const DEADLINE_FAR_MS = Date.UTC(2026, 0, 2, 23, 0, 0);
const DEADLINE_NEAR_MS = resolveDeadlineAtMsFor('21:00');
const DEADLINE_TIGHT_MS = resolveDeadlineAtMsFor('18:30');

const evCandidate = (overrides: Partial<DeferredObjectivePlanPreviewCandidate> = {}): DeferredObjectivePlanPreviewCandidate => ({
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 60,
  deadlineAtMs: DEADLINE_FAR_MS,
  ...overrides,
} as DeferredObjectivePlanPreviewCandidate);

const temperatureCandidate = (
  overrides: Partial<DeferredObjectivePlanPreviewCandidate> = {},
): DeferredObjectivePlanPreviewCandidate => ({
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 65,
  deadlineAtMs: DEADLINE_FAR_MS,
  ...overrides,
} as DeferredObjectivePlanPreviewCandidate);

describe('previewDeferredObjectivePlan', () => {
  it('projects an on-track EV candidate with scheduled hours, finish, energy, and cost', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('on_track');
    expect(estimate.scheduledHours.length).toBeGreaterThan(0);
    expect(estimate.scheduledHours).toEqual(
      [...estimate.scheduledHours].sort((a, b) => a.startsAtMs - b.startsAtMs),
    );
    expect(estimate.projectedFinishAtMs).not.toBeNull();
    // 20% remaining × 0.2 kWh/% = 4 kWh expected.
    expect(estimate.energyEstimateKWh).toBeCloseTo(4, 3);
    expect(estimate.costEstimate).not.toBeNull();
    expect(estimate.costEstimate).toBeGreaterThan(0);
    // `costEstimate` is a TOTAL amount, so its unit must be a money unit, never
    // a per-kWh rate: the "øre/kWh" rate label is converted down to "øre".
    expect(estimate.costUnit).toBe('øre');
    expect(estimate.costUnit).not.toMatch(/\/kwh/i);
  });

  it('emits an hourly priceSeries across the window, aligned with scheduled hours, labelled with the rate unit', () => {
    const prices = [
      10, 9, 8, 7, 6, 5, 6, 7, 8, 12, 16, 20,
      18, 15, 13, 14, 17, 22, 26, 24, 20, 16, 13, 11,
    ];
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices }),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    const series = estimate.priceSeries ?? [];
    expect(series.length).toBeGreaterThan(0);
    // Ascending by start, and strictly inside the [now, deadline) window.
    for (let index = 1; index < series.length; index += 1) {
      expect(series[index].startsAtMs).toBeGreaterThan(series[index - 1].startsAtMs);
    }
    expect(series[series.length - 1].startsAtMs).toBeLessThan(DEADLINE_FAR_MS);
    // The widget highlights chosen hours by intersecting `startsAtMs`, so every
    // scheduled hour MUST appear in the price curve — otherwise the band/dots
    // would never line up with the line.
    const starts = new Set(series.map((point) => point.startsAtMs));
    for (const hour of estimate.scheduledHours) {
      expect(starts.has(hour.startsAtMs)).toBe(true);
    }
  });

  it('omits priceSeries when the projection is unavailable (no snapshot)', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: null,
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('missing_prices');
    expect(estimate.priceSeries).toBeUndefined();
  });

  // ── At-cap honesty signal (atCapNow) ──────────────────────────────────────
  // The in-isolation preview is optimistic about headroom. `atCapNow` corrects
  // its "runs now" implication with a measured FACT: the candidate is scheduled
  // in the current clock hour AND the measured whole-home draw is already at the
  // physical hard cap.
  const CURRENT_HOUR_START_MS = Math.floor(NOW_MS / HOUR_MS) * HOUR_MS;

  it('flags atCapNow when the current hour is scheduled and measured draw is at the hard cap', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker({ lastPowerW: 10_000, lastTimestamp: NOW_MS }),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    // A tight deadline forces the planner to schedule the current hour.
    const estimate = runPreview({
      deviceId: 'ev-1', candidate: evCandidate({ deadlineAtMs: DEADLINE_TIGHT_MS }), ctx,
    });
    expect(estimate.scheduledHours.some((hour) => hour.startsAtMs === CURRENT_HOUR_START_MS)).toBe(true);
    expect(estimate.atCapNow).toBe(true);
  });

  it('does not flag atCapNow when measured draw is comfortably below the hard cap', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker({ lastPowerW: 2_000, lastTimestamp: NOW_MS }),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({
      deviceId: 'ev-1', candidate: evCandidate({ deadlineAtMs: DEADLINE_TIGHT_MS }), ctx,
    });
    expect(estimate.atCapNow).toBe(false);
  });

  it('omits atCapNow when the measured sample is stale (no honest claim off a dead reading)', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      // At cap, but the sample is 10 minutes old → too stale to assert "at cap now".
      powerTracker: buildEvPowerTracker({ lastPowerW: 10_000, lastTimestamp: NOW_MS - 10 * 60 * 1000 }),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({
      deviceId: 'ev-1', candidate: evCandidate({ deadlineAtMs: DEADLINE_TIGHT_MS }), ctx,
    });
    expect(estimate.atCapNow).toBeUndefined();
  });

  it('omits atCapNow when the measured sample has a negative age (future timestamp / clock drift)', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      // At cap, but the sample is timestamped in the future → negative age must
      // fail the freshness contract just like a too-stale reading.
      powerTracker: buildEvPowerTracker({ lastPowerW: 10_000, lastTimestamp: NOW_MS + 5 * 60 * 1000 }),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({
      deviceId: 'ev-1', candidate: evCandidate({ deadlineAtMs: DEADLINE_TIGHT_MS }), ctx,
    });
    expect(estimate.atCapNow).toBeUndefined();
  });

  // ── Granted rescue permissions (honest "Extra permissions" summary) ────────
  // The producer is handed the ALREADY-GATED candidate (the caller runs
  // `App.gateCandidateExtraPermissions` first), so it reflects the surviving
  // permission set verbatim. A non-eligible device's gated candidate carries
  // only `exemptFromBudget`, so the summary must NOT claim the boost.
  it('reflects both granted rescue permissions when the gated candidate carries both', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({
      deviceId: 'ev-1',
      candidate: evCandidate({ rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' } }),
      ctx,
    });
    expect(estimate.grantedRescuePermissions).toEqual({
      exemptFromBudget: true,
      limitLowerPriorityDevices: true,
    });
  });

  it('reports limitLowerPriorityDevices:false when the gate dropped the boost (non-eligible device)', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    // The gate keeps only `exemptFromBudget` for a device that can't use the boost.
    const estimate = runPreview({
      deviceId: 'ev-1',
      candidate: evCandidate({ rescue: { exemptFromBudget: 'always' } }),
      ctx,
    });
    expect(estimate.grantedRescuePermissions).toEqual({
      exemptFromBudget: true,
      limitLowerPriorityDevices: false,
    });
  });

  it('omits grantedRescuePermissions when the candidate carries no rescue permissions', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });
    expect(estimate.grantedRescuePermissions).toBeUndefined();
  });

  it('projects an on-track temperature candidate as an estimate', () => {
    const ctx: PreviewContext = {
      device: buildTemperatureDevice(),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'heater-1', candidate: temperatureCandidate(), ctx });

    expect(estimate.status).toBe('on_track');
    expect(estimate.scheduledHours.length).toBeGreaterThan(0);
    // 10°C remaining × 0.8 kWh/°C = 8 kWh.
    expect(estimate.energyEstimateKWh).toBeCloseTo(8, 3);
    expect(estimate.projectedFinishAtMs).not.toBeNull();
  });

  it('tags unavailable as needs_observation when the device has no learned profile yet', () => {
    const ctx: PreviewContext = {
      // Prices ARE available and optimisation is on — the only thing missing is a
      // learned energy profile for this thermostat (no temperature bootstrap),
      // so resolveProfileEnergy returns objective_missing_capacity.
      device: buildTemperatureDevice(),
      powerTracker: { objectiveProfiles: {} } as PowerTrackerState,
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'heater-1', candidate: temperatureCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('needs_observation');
    expect(estimate.scheduledHours).toEqual([]);
    expect(estimate.energyEstimateKWh).toBeNull();
  });

  it('tags unavailable as needs_observation for a thermal learned-rate device with no executable step', () => {
    const ctx: PreviewContext = {
      // Learned kWh/°C is present, but the device has no stepped profile and no
      // measured/planning power, so resolveObjectiveSteps is empty →
      // objective_missing_charge_rate. For a thermal device that is the same
      // "not observed yet" cold-start as missing_capacity.
      device: buildTemperatureDevice({
        steppedLoadProfile: undefined,
        measuredPowerKw: undefined,
        expectedPowerKw: undefined,
        powerKw: undefined,
        planningPowerKw: undefined,
      }),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'heater-1', candidate: temperatureCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('needs_observation');
  });

  it('tags unavailable with the missing input when price-aware planning is off', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      // Optimisation off → policy horizon unavailable for a specific reason. This
      // is not a missing profile, but it still earns explicit copy instead of
      // falling through to the generic unavailable line.
      priceOptimizationEnabled: false,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('price_feature_disabled');
  });

  it('tags unavailable as not_resumable when the charger is connected but cannot resume (plugged_in)', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice({ evChargingState: 'plugged_in' }),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('not_resumable');
  });

  it('returns at_risk when the deadline forces the plan into its safety reserve', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate({ deadlineAtMs: DEADLINE_NEAR_MS }), ctx });

    expect(estimate.status).toBe('at_risk');
    expect(estimate.scheduledHours.length).toBeGreaterThan(0);
    expect(estimate.energyEstimateKWh).toBeCloseTo(4, 3);
  });

  it('returns cannot_meet when there is not enough time/capacity before the deadline', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate({ deadlineAtMs: DEADLINE_TIGHT_MS }), ctx });

    expect(estimate.status).toBe('cannot_meet');
    // The floor cannot fit the full target, but the planner still books the
    // hours it can — energy needed is surfaced regardless.
    expect(estimate.energyEstimateKWh).toBeCloseTo(4, 3);
  });

  it('returns satisfied with no scheduled hours when the target is already met', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice({ stateOfCharge: { percent: 80, status: 'fresh', observedAtMs: NOW_MS } }),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('satisfied');
    expect(estimate.scheduledHours).toEqual([]);
    expect(estimate.energyEstimateKWh).toBe(0);
    expect(estimate.projectedFinishAtMs).toBeNull();
    expect(estimate.costEstimate).toBeNull();
  });

  it('returns unavailable when the device is not in the snapshot', () => {
    const ctx: PreviewContext = {
      device: undefined,
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('missing_device');
    expect(estimate.scheduledHours).toEqual([]);
    expect(estimate.projectedFinishAtMs).toBeNull();
    expect(estimate.energyEstimateKWh).toBeNull();
    expect(estimate.energyExpectedKWh).toBeNull();
    expect(estimate.costEstimate).toBeNull();
  });

  it('returns unavailable when price-aware optimisation is disabled', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('price_feature_disabled');
    expect(estimate.energyEstimateKWh).toBeNull();
  });

  it('omits the cost unit when no price is available for the scheduled buckets', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      // No snapshot → policy horizon unavailable → projection unavailable, so
      // there is no schedule to price.
      dailyBudgetSnapshot: null,
      priceOptimizationEnabled: true,
      hardCapKw: 10,
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.status).toBe('unavailable');
    expect(estimate.unavailableReason).toBe('missing_prices');
    expect(estimate.costEstimate).toBeNull();
    expect(estimate.costUnit).toBeUndefined();
  });

  it('passes a bare-currency rate label (Homey scheme) through to the cost unit unchanged', () => {
    const ctx: PreviewContext = {
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
      hardCapKw: 10,
      // Homey Energy / Flow schemes expose an already-amount-shaped label
      // (a bare currency or the neutral fallback) — no "/kWh" to strip.
      priceRateLabel: 'NOK',
    };
    const estimate = runPreview({ deviceId: 'ev-1', candidate: evCandidate(), ctx });

    expect(estimate.costEstimate).not.toBeNull();
    expect(estimate.costUnit).toBe('NOK');
    expect(estimate.costUnit).not.toMatch(/\/kwh/i);
  });
});

// ── Fidelity regression: the preview's projection must match what the active-
// plan recorder persists for the SAME inputs, since both paths reuse the same
// diagnostic pipeline and schedule helpers. ─────────────────────────────────

describe('previewDeferredObjectivePlan fidelity vs activePlanRecorder', () => {
  const fidelityCases: ReadonlyArray<{
    name: string;
    deviceId: string;
    device: PlanInputDevice;
    powerTracker: PowerTrackerState;
    candidate: DeferredObjectivePlanPreviewCandidate;
  }> = [
    {
      name: 'EV SoC',
      deviceId: 'ev-1',
      device: buildEvDevice(),
      powerTracker: buildEvPowerTracker(),
      candidate: evCandidate(),
    },
    {
      name: 'temperature',
      deviceId: 'heater-1',
      device: buildTemperatureDevice(),
      powerTracker: buildTemperaturePowerTracker(),
      candidate: temperatureCandidate(),
    },
  ];

  it.each(fidelityCases)(
    'matches recorder hours, energy, and finish for a $name objective',
    ({ deviceId, device, powerTracker, candidate }) => {
      const dailyBudgetSnapshot = buildSnapshot();
      const hardCapKw = 10;

      // Live path: build the diagnostic exactly as the plan cycle does, feed it
      // to the recorder, and read what it persists.
      const settings = buildSettings({ deviceId, candidate });
      const diagnostics = buildDeferredObjectiveDiagnostics({
        nowMs: NOW_MS,
        timeZone: 'UTC',
        devices: [device],
        settings,
        powerTracker,
        dailyBudgetSnapshot,
        priceOptimizationEnabled: true,
        activePlans: null,
        hardCapKw,
      });
      expect(diagnostics).toHaveLength(1);
      const diag = diagnostics[0]!;
      expect(diag.horizonPlan).toBeDefined();

      const { recorder } = buildRecorder();
      recorder.observe(diagnostics, NOW_MS);
      const persisted = recorder.getPlanForTests(deviceId);
      const recorderHours = persisted?.latest?.hours ?? [];
      // The recorder stamps `plannedUnitMilestone` and `cheaperHourAhead`
      // (control-gate fields); the preview/schedule fidelity is about which hours
      // carry what energy, so compare the schedule shape without them.
      const recorderSchedule = recorderHours.map(
        ({ plannedUnitMilestone: _m, cheaperHourAhead: _c, ...hour }) => hour,
      );
      const recorderEnergyKWh = persisted?.latest?.energyNeededKWh ?? null;
      const recorderFinishAtMs = resolveProjectedFinishAtMs(diag);
      // Sanity-check the recorder produced a non-trivial schedule from the
      // shared helper so the comparison below is meaningful.
      expect(recorderSchedule).toEqual(buildHoursFromHorizonPlan(diag));
      expect(recorderHours.length).toBeGreaterThan(0);

      // Preview path: same inputs, no persisted state.
      const estimate = runPreview({
        deviceId,
        candidate,
        ctx: { device, powerTracker, dailyBudgetSnapshot, priceOptimizationEnabled: true, hardCapKw },
      });

      // Scheduled hours must match exactly (same shared `buildHoursFromHorizonPlan`).
      expect(estimate.scheduledHours).toEqual(recorderSchedule);
      // Energy must match the persisted buffered figure exactly (same rounding).
      expect(estimate.energyEstimateKWh).toBe(recorderEnergyKWh);
      // Finish must match within a small tolerance.
      expect(estimate.projectedFinishAtMs).not.toBeNull();
      expect(Math.abs((estimate.projectedFinishAtMs ?? 0) - (recorderFinishAtMs ?? 0)))
        .toBeLessThanOrEqual(1000);
    },
  );
});

describe('buildDeferredObjectivePolicyWindowPrices', () => {
  // A snapshot whose hourly buckets start at an offset past the UTC hour — the
  // shape a fractional-offset timezone (UTC+5:30/+5:45) produces, where the local
  // day boundary lands at :30/:45 past a UTC hour.
  const offsetSnapshot = (params: { offsetMinutes: number; prices?: number[] }): DailyBudgetUiPayload => {
    const day = buildDay({
      dateKey: '2026-01-01',
      startMs: Date.UTC(2026, 0, 1, 0, params.offsetMinutes),
      currentBucketIndex: 0,
      prices: params.prices,
    });
    return { days: { [day.dateKey]: day }, todayKey: '2026-01-01', tomorrowKey: '' };
  };

  it('floors every point to the epoch hour, so a fractional-offset zone still joins with scheduledHours', () => {
    // Buckets at :30 past the hour (UTC+5:30 day boundary). Raw starts would be
    // 21:30, 22:30… and never match scheduledHours' epoch-hour-floored starts.
    const series = buildDeferredObjectivePolicyWindowPrices(
      offsetSnapshot({ offsetMinutes: 30 }),
      Date.UTC(2026, 0, 1, 2, 0),
      Date.UTC(2026, 0, 1, 8, 0),
    );
    expect(series.length).toBeGreaterThan(0);
    for (const point of series) {
      // Epoch-hour aligned (the basis buildHoursFromHorizonPlan uses).
      expect(point.startMs % HOUR_MS).toBe(0);
    }
    // Dense + ascending: one slot per hour, no skipped indices.
    for (let index = 1; index < series.length; index += 1) {
      expect(series[index].startMs - series[index - 1].startMs).toBe(HOUR_MS);
    }
  });

  it('keys the in-progress straddling bucket by its clipped start, matching scheduledHours', () => {
    // :30 buckets; now at 02:05 sits inside the 01:30–02:30 bucket. A raw floor
    // would key that bucket to 01:00 (a spurious pre-now hour the current
    // scheduled hour never matches); clipping to now keys it to 02:00.
    const series = buildDeferredObjectivePolicyWindowPrices(
      offsetSnapshot({ offsetMinutes: 30 }),
      Date.UTC(2026, 0, 1, 2, 5),
      Date.UTC(2026, 0, 1, 8, 0),
    );
    const starts = series.map((point) => point.startMs);
    expect(starts).toContain(Date.UTC(2026, 0, 1, 2, 0));
    expect(starts).not.toContain(Date.UTC(2026, 0, 1, 1, 0));
    // The 01:30–02:30 (current) and 02:30–03:30 buckets both floor to 02:00;
    // the current one (default price = its index 1) must win, not the next (2).
    const currentHour = series.find((point) => point.startMs === Date.UTC(2026, 0, 1, 2, 0));
    expect(currentHour?.price).toBe(1);
  });

  it('emits a dense null-price slot for an interior unpriced hour rather than dropping it', () => {
    // Hour index 4 has a non-finite price → dropped from the bucket source, so it
    // must surface as a null slot (the chart breaks the line; the x-axis stays true).
    const prices = Array.from({ length: 24 }, (_, index) => (index === 4 ? Number.NaN : 10 + index));
    const series = buildDeferredObjectivePolicyWindowPrices(
      offsetSnapshot({ offsetMinutes: 0, prices }),
      Date.UTC(2026, 0, 1, 2, 0),
      Date.UTC(2026, 0, 1, 8, 0),
    );
    const gap = series.find((point) => point.startMs === Date.UTC(2026, 0, 1, 4, 0));
    expect(gap).toBeDefined();
    expect(gap?.price).toBeNull();
    // Still dense around the gap (the slot is present, not skipped).
    for (let index = 1; index < series.length; index += 1) {
      expect(series[index].startMs - series[index - 1].startMs).toBe(HOUR_MS);
    }
  });

  it('returns an empty series when the snapshot is null or has no priced buckets in the window', () => {
    expect(buildDeferredObjectivePolicyWindowPrices(null, 0, HOUR_MS)).toEqual([]);
    // Window entirely before the snapshot's buckets → no overlap.
    const series = buildDeferredObjectivePolicyWindowPrices(
      offsetSnapshot({ offsetMinutes: 0 }),
      Date.UTC(2025, 11, 31, 0, 0),
      Date.UTC(2025, 11, 31, 6, 0),
    );
    expect(series).toEqual([]);
  });
});
