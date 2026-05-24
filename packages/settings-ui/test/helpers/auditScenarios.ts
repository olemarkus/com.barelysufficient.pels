/**
 * Typed audit scenarios for the Settings UI browser stub and unit-test mock.
 *
 * Each scenario produces a coherent `BootstrapAuditScenario` — a partial set of
 * overrides that, when applied at the Homey SDK boundary, render a specific UI
 * state repeatably (normal, pressure, over-budget, missing-price,
 * empty-history, dense-device).
 *
 * Design constraints:
 * - Scenarios live at the SDK boundary: the route handlers in
 *   `homey.stub.js` and `homeyApiMock.ts` consult the scenario for response
 *   patches, but the UI components themselves never receive a scenario flag.
 *   This means flipping a scenario flips the API responses, not component
 *   props.
 * - Scenarios are typed against the production contracts
 *   (`SettingsUiBootstrap`, `SettingsUiPlanSnapshot`, `SettingsUiPowerPayload`,
 *   `DailyBudgetUiPayload`, `DeferredObjectiveActivePlansV1`,
 *   `SettingsUiDeviceDiagnosticsPayload`,
 *   `SettingsUiDeferredObjectivePlanHistoryPayload`) so compile errors catch
 *   contract drift early. No `as any` casts.
 * - Scenarios produce **patches** layered on top of the stub's existing baseline,
 *   not full bootstrap payloads. The baseline lives in the browser stub
 *   (`packages/settings-ui/tests/e2e/fixtures/homey.stub.js`); scenarios only
 *   describe the deltas that distinguish them from baseline.
 * - The browser-side scenario library (`homey.stub.js`) mirrors the names and
 *   semantic intent of the scenarios here. A parity unit test
 *   (`auditScenarios.test.ts`) enforces both surfaces stay in sync.
 *
 * Add a new scenario:
 * 1. Add the scenario name to `AUDIT_SCENARIO_NAMES`.
 * 2. Add a factory function below that returns a `BootstrapAuditScenario`.
 * 3. Mirror the same name + intent in the `BROWSER_AUDIT_SCENARIOS` object in
 *    `packages/settings-ui/tests/e2e/fixtures/homey.stub.js`.
 * 4. The parity test enforces step 3 — it will fail if you skip it.
 * 5. Document the scenario intent in `notes/browser-stub.md`.
 */

import type {
  DailyBudgetDayPayload,
  DailyBudgetUiPayload,
} from '../../../contracts/src/dailyBudgetTypes.ts';
import type {
  DeferredObjectiveActivePlansV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type {
  SettingsUiDeferredObjectivePlanHistoryPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import type {
  SettingsUiDeviceDiagnosticsPayload,
} from '../../../contracts/src/deviceDiagnosticsTypes.ts';
import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanSnapshot,
  SettingsUiPowerPayload,
} from '../../../contracts/src/settingsUiApi.ts';

/**
 * Stable list of scenarios. The order is the order they appear in
 * `notes/browser-stub.md` so docs stay grep-aligned with code.
 */
export const AUDIT_SCENARIO_NAMES = [
  'normal',
  'pressure',
  'over-budget',
  'missing-price',
  'empty-history',
  'dense-device',
] as const;

export type AuditScenarioName = (typeof AUDIT_SCENARIO_NAMES)[number];

/**
 * Patch applied to the baseline bootstrap. Each field is optional; the route
 * handler merges only the present fields onto its default. Settings overrides
 * are applied via the SDK boundary's `Homey.get(...)`, not by mutating UI
 * state.
 */
export type BootstrapAuditScenario = {
  description: string;
  /** Sparse map of settings keys to override at `Homey.get(key)` time. */
  settings?: Record<string, unknown>;
  /** Override for `/ui_plan` and `bootstrap.plan`. */
  plan?: SettingsUiPlanSnapshot | null;
  /** Override for `/ui_power` and `bootstrap.power`. */
  power?: SettingsUiPowerPayload;
  /** Override for `/daily_budget`, `bootstrap.dailyBudget`, and applies/recomputes. */
  dailyBudget?: DailyBudgetUiPayload | null;
  /** Override for `/ui_deferred_objective_history`. */
  deferredObjectiveHistory?: SettingsUiDeferredObjectivePlanHistoryPayload;
  /** Override for `/ui_device_diagnostics`. */
  deviceDiagnostics?: SettingsUiDeviceDiagnosticsPayload;
  /** Override for `bootstrap.deferredObjectiveActivePlans`. */
  deferredObjectiveActivePlans?: DeferredObjectiveActivePlansV1 | null;
};

const HOUR_MS = 3600 * 1000;

const dateKeyUtc = (ms: number): string => {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const startOfUtcDayMs = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
};

type BuildDayOptions = {
  /** Override the time-dependent `currentBucketIndex` so the scenario's
   * `exceeded`/`usedNowKWh` state is stable regardless of when the test runs.
   * Without this, an `over-budget` scenario in a 02:00 UTC CI run would show
   * `exceeded: false` because the cumulative actual hasn't crossed the
   * budget yet — defeating the scenario's intent. */
  pinCurrentBucketIndex?: number;
};

const buildDay = (
  dayStartMs: number,
  nowMs: number,
  perBucketKWh: number,
  actualMultiplier: number,
  dailyBudgetKWh: number,
  pricesPerHour: Array<number | null>,
  options: BuildDayOptions = {},
): DailyBudgetDayPayload => {
  const startUtc: string[] = [];
  const startLocalLabels: string[] = [];
  const plannedWeight: number[] = [];
  const plannedKWh: number[] = [];
  const plannedControlledKWh: number[] = [];
  const plannedUncontrolledKWh: number[] = [];
  const actualKWh: number[] = [];
  const actualControlledKWh: Array<number | null> = [];
  const actualUncontrolledKWh: Array<number | null> = [];
  const allowedCumKWh: number[] = [];
  let cum = 0;
  const wallClockBucketIndex = Math.max(0, Math.min(23, Math.floor((nowMs - dayStartMs) / HOUR_MS)));
  const currentBucketIndex = typeof options.pinCurrentBucketIndex === 'number'
    ? Math.max(0, Math.min(23, options.pinCurrentBucketIndex))
    : wallClockBucketIndex;
  for (let i = 0; i < 24; i += 1) {
    const t = dayStartMs + i * HOUR_MS;
    startUtc.push(new Date(t).toISOString());
    startLocalLabels.push(String(i).padStart(2, '0'));
    plannedWeight.push(1);
    plannedKWh.push(Number(perBucketKWh.toFixed(3)));
    plannedControlledKWh.push(Number((perBucketKWh * 0.4).toFixed(3)));
    plannedUncontrolledKWh.push(Number((perBucketKWh * 0.6).toFixed(3)));
    const actual = Number((perBucketKWh * actualMultiplier).toFixed(3));
    actualKWh.push(actual);
    actualControlledKWh.push(i <= currentBucketIndex ? Number((actual * 0.4).toFixed(3)) : null);
    actualUncontrolledKWh.push(i <= currentBucketIndex ? Number((actual * 0.6).toFixed(3)) : null);
    cum += perBucketKWh;
    allowedCumKWh.push(Number(cum.toFixed(3)));
  }
  const usedNowKWh = actualKWh.slice(0, currentBucketIndex + 1).reduce((sum, v) => sum + v, 0);
  const allowedNowKWh = allowedCumKWh[currentBucketIndex] ?? 0;
  const remainingKWh = dailyBudgetKWh - usedNowKWh;
  const deviationKWh = usedNowKWh - allowedNowKWh;
  return {
    dateKey: dateKeyUtc(dayStartMs),
    timeZone: 'UTC',
    nowUtc: new Date(nowMs).toISOString(),
    dayStartUtc: new Date(dayStartMs).toISOString(),
    currentBucketIndex,
    budget: {
      enabled: true,
      dailyBudgetKWh,
      priceShapingEnabled: true,
    },
    state: {
      usedNowKWh: Number(usedNowKWh.toFixed(3)),
      allowedNowKWh: Number(allowedNowKWh.toFixed(3)),
      remainingKWh: Number(remainingKWh.toFixed(3)),
      deviationKWh: Number(deviationKWh.toFixed(3)),
      exceeded: remainingKWh < 0,
      frozen: false,
      confidence: 0.72,
      priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels,
      plannedWeight,
      plannedKWh,
      plannedControlledKWh,
      plannedUncontrolledKWh,
      actualKWh,
      actualControlledKWh,
      actualUncontrolledKWh,
      allowedCumKWh,
      price: pricesPerHour,
    },
  };
};

const buildSinglePayload = (
  dayStartMs: number,
  nowMs: number,
  perBucketKWh: number,
  actualMultiplier: number,
  dailyBudgetKWh: number,
  pricesPerHour: Array<number | null>,
  options: BuildDayOptions = {},
): DailyBudgetUiPayload => {
  const day = buildDay(
    dayStartMs,
    nowMs,
    perBucketKWh,
    actualMultiplier,
    dailyBudgetKWh,
    pricesPerHour,
    options,
  );
  return {
    days: { [day.dateKey]: day },
    todayKey: day.dateKey,
    tomorrowKey: null,
    yesterdayKey: null,
  };
};

const buildPressurePlanSnapshot = (): SettingsUiPlanSnapshot => {
  // capacityShortfall + soft limit pressed: planned shed across two devices,
  // total > soft limit, headroom collapsed.
  const meta: SettingsUiPlanMetaSnapshot = {
    totalKw: 8.6,
    softLimitKw: 8.0,
    capacitySoftLimitKw: 8.0,
    hardLimitKw: 8.0,
    softLimitSource: 'capacity',
    headroomKw: 0,
    powerKnown: true,
    hasLivePowerSample: true,
    capacityShortfall: true,
    shortfallBudgetThresholdKw: 8.0,
    shortfallBudgetHeadroomKw: 0,
    hardCapLimitKw: 8.0,
    hardCapHeadroomKw: 0,
    usedKWh: 3.8,
    budgetKWh: 4.5,
    hourBudgetKWh: 4.5,
    minutesRemaining: 14,
    controlledKw: 6.3,
    uncontrolledKw: 2.3,
    hourControlledKWh: 1.6,
    hourUncontrolledKWh: 0.6,
  };
  const devices: SettingsUiPlanDeviceSnapshot[] = [
    {
      id: 'dev_waterheater',
      name: 'Water Heater',
      currentState: 'on',
      plannedState: 'shed',
      priority: 2,
      controllable: true,
      expectedPowerKw: 2.0,
      measuredPowerKw: 2.1,
      reason: { code: 'capacity', detail: 'capacity shortfall' },
      shedAction: 'turn_off',
    },
    {
      id: 'dev_evcharger',
      name: 'Generic EV Charger',
      currentState: 'on',
      plannedState: 'shed',
      priority: 6,
      controllable: true,
      expectedPowerKw: 7.2,
      measuredPowerKw: 6.8,
      reason: { code: 'capacity', detail: 'capacity shortfall' },
      shedAction: 'turn_off',
    },
  ];
  return { meta, devices };
};

const buildOverBudgetDailyBudget = (): DailyBudgetUiPayload => {
  const nowMs = Date.now();
  const dayStartMs = startOfUtcDayMs(nowMs);
  // Plan 0.5 kWh/h × 24 = 12 kWh budget, actual 1.8× planned. Pin the
  // current-bucket index to 18 so the cumulative actual (~16.2 kWh) is
  // guaranteed above the 12 kWh budget regardless of when the audit runs —
  // without pinning, a 02:00 UTC run reports `exceeded: false` and the
  // chip wouldn't render, defeating the scenario's intent.
  const prices = Array.from({ length: 24 }, (_, i) => 80 + 35 * Math.sin((i / 24) * Math.PI * 2 - Math.PI / 2));
  return buildSinglePayload(dayStartMs, nowMs, 0.5, 1.8, 12, prices, { pinCurrentBucketIndex: 18 });
};

const buildMissingPriceDailyBudget = (): DailyBudgetUiPayload => {
  const nowMs = Date.now();
  const dayStartMs = startOfUtcDayMs(nowMs);
  // Price array is all-null → priceShapingActive should still be true but the
  // chart has nothing to render.
  return buildSinglePayload(dayStartMs, nowMs, 0.5, 0.95, 12, Array.from({ length: 24 }, () => null));
};

const buildDenseDevicePlan = (): SettingsUiPlanSnapshot => {
  // 12 controllable devices spanning thermostats, water heater, EV. Tests
  // long-list rendering, scroll, priority-table density.
  const meta: SettingsUiPlanMetaSnapshot = {
    totalKw: 4.7,
    softLimitKw: 8.0,
    capacitySoftLimitKw: 8.0,
    hardLimitKw: 8.0,
    softLimitSource: 'capacity',
    headroomKw: 3.3,
    powerKnown: true,
    hasLivePowerSample: true,
    usedKWh: 1.2,
    budgetKWh: 4.5,
    hourBudgetKWh: 4.5,
    minutesRemaining: 33,
    controlledKw: 2.5,
    uncontrolledKw: 2.2,
    hourControlledKWh: 0.6,
    hourUncontrolledKWh: 0.6,
  };
  const devices: SettingsUiPlanDeviceSnapshot[] = [];
  for (let i = 0; i < 12; i += 1) {
    devices.push({
      id: `dev_room_${i + 1}`,
      name: `Room ${i + 1} Thermostat`,
      currentState: i % 3 === 0 ? 'off' : 'on',
      plannedState: 'keep',
      controlModel: 'temperature_target',
      deviceClass: 'thermostat',
      currentTarget: 21,
      plannedTarget: 21,
      currentTemperature: 19 + (i % 5),
      priority: 1 + (i % 5),
      controllable: true,
      expectedPowerKw: 0.4,
      measuredPowerKw: i % 3 === 0 ? 0 : 0.32,
      reason: { code: 'keep', detail: null },
      shedAction: 'set_temperature',
      shedTemperature: 15,
    });
  }
  return { meta, devices };
};

const buildSampleHistoryEntry = (
  deviceId: string,
  finalizedAtMs: number,
  outcome: 'met' | 'missed' | 'abandoned' = 'met',
): SettingsUiDeferredObjectivePlanHistoryPayload['entriesByDeviceId'][string][number] => ({
  id: `sample-${deviceId}-${finalizedAtMs}`,
  deviceId,
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: finalizedAtMs - 30 * 60 * 1000,
  startedAtMs: finalizedAtMs - 6 * HOUR_MS,
  finalizedAtMs,
  startProgressC: 48,
  startProgressPercent: null,
  finalProgressC: outcome === 'met' ? 65 : 58,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 8.5,
  outcome,
  metAtMs: outcome === 'met' ? finalizedAtMs - 30 * 60 * 1000 : null,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [
    { fromMs: finalizedAtMs - 6 * HOUR_MS, toMs: finalizedAtMs },
  ],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
});

const SCENARIO_FACTORIES: Record<AuditScenarioName, () => BootstrapAuditScenario> = {
  normal: () => ({
    description: 'Baseline state matching the stub defaults: capacity OK, budget on track, prices fresh, smart task active and on-track.',
  }),
  pressure: () => ({
    description: 'Capacity guard active: total power above the soft limit, headroom collapsed, two devices planned to shed.',
    plan: buildPressurePlanSnapshot(),
    power: {
      tracker: null,
      status: {
        capacityShortfall: true,
        shortfallBudgetThresholdKw: 8.0,
        shortfallBudgetHeadroomKw: 0,
        hardCapHeadroomKw: 0,
        headroomKw: 0,
        powerKnown: true,
        hasLivePowerSample: true,
        powerFreshnessState: 'fresh',
        lastPowerUpdate: Date.now() - 5 * 1000,
      },
      heartbeat: Date.now() - 4 * 1000,
    },
  }),
  'over-budget': () => ({
    description: 'Daily budget exhausted: actual usage runs ~80% above planned and the over-budget chip should appear.',
    settings: {
      daily_budget_enabled: true,
      daily_budget_kwh: 12,
      daily_budget_price_shaping_enabled: true,
    },
    dailyBudget: buildOverBudgetDailyBudget(),
  }),
  'missing-price': () => ({
    description: 'Price feed unavailable: combined_prices is null, daily-budget price array is all-null.',
    settings: {
      combined_prices: null,
      electricity_prices: null,
      homey_prices_today: null,
      homey_prices_tomorrow: null,
      flow_prices_today: null,
      flow_prices_tomorrow: null,
    },
    dailyBudget: buildMissingPriceDailyBudget(),
  }),
  'empty-history': () => ({
    description: 'No smart-task history yet: deferredObjectiveHistory and active plans both empty so the past-tasks list shows its zero-state.',
    deferredObjectiveActivePlans: { version: 1, plansByDeviceId: {} },
    deferredObjectiveHistory: { version: 1, entriesByDeviceId: {} },
  }),
  'dense-device': () => ({
    description: 'Twelve controllable thermostats so the device list and priority table render at scroll-stress density.',
    plan: buildDenseDevicePlan(),
  }),
};

export const buildAuditScenario = (name: AuditScenarioName): BootstrapAuditScenario => (
  SCENARIO_FACTORIES[name]()
);

export const AUDIT_SCENARIOS: Readonly<Record<AuditScenarioName, () => BootstrapAuditScenario>> =
  SCENARIO_FACTORIES;

/**
 * Build a representative non-empty history payload (used by the parity test
 * and by the helper in tests that need to assert non-zero history rendering).
 */
export const buildSampleHistoryPayload = (): SettingsUiDeferredObjectivePlanHistoryPayload => {
  const nowMs = Date.now();
  return {
    version: 1,
    entriesByDeviceId: {
      dev_connected300: [
        buildSampleHistoryEntry('dev_connected300', nowMs - 2 * 24 * HOUR_MS, 'met'),
        buildSampleHistoryEntry('dev_connected300', nowMs - 5 * 24 * HOUR_MS, 'missed'),
      ],
    },
  };
};
