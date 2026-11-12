import { describe, expect, it, onTestFinished } from 'vitest';
import { ContinuousBatteryPlanService } from '../../lib/battery/continuousBatteryPlanService';
import type { ContinuousBatteryEnergyHorizon } from '../../lib/ports/continuousBatteryPlan';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type {
  ContinuousBatteryPlanConfig, ContinuousBatteryPlanRead,
} from '../../packages/contracts/src/continuousBatteryPlan';
import {
  CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY,
  DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
  isBatteryPlanUnitSettled,
  parseContinuousBatteryPlanConfig,
  parseContinuousBatteryPlanConfigs,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import { perBatterySource, type PerBatterySourceInput } from '../helpers/batteryPlanSource';
import { captureDebugTopic, captureLogger } from '../utils/loggerCapture';

const NOW = Date.parse('2026-10-27T00:00:00Z');
const config: ContinuousBatteryPlanConfig = {
  ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR/kWh',
};
const horizon: ContinuousBatteryEnergyHorizon = {
  battery: {
    capacityKWh: 10,
    gridCharge: { kind: 'any' }, storedEnergyKWh: 4, minimumEnergyKWh: 2,
    maxChargeKW: 2.5, chargeTaper: [], maxDischargeKW: 2.5, roundTripEfficiency: 0.9,
    wearCostPerKWh: 0.03, terminalValuePerKWh: 0.1,
  },
  periods: [{
    startsAtMs: NOW, durationMs: 3_600_000,
    importPrice: 0.2, exportPrice: 0, householdDemandKWh: 0.5, otherManagedDemandKWh: 0,
    solarKWh: 0, gridImportLimitKW: 5, maxChargeKW: 2.5, otherStorageKWh: 0, laterSupplyKW: 0,
  }],
};
const source: PerBatterySourceInput = {
  getNowMs: () => NOW,
  readHorizon: () => ({ kind: 'ready', exportPricing: 'complete', horizon, priceUnit: 'EUR/kWh' }),
};

const settingsStore = (initial: Record<string, unknown> = {}) => {
  const values = new Map<string, unknown>(Object.entries(initial));
  let unavailable = false;
  const settings: SettingsPort = {
    get: key => unavailable ? null : (values.get(key) ?? null),
    set: (key, value) => { values.set(key, value); },
    unset: key => { values.delete(key); },
    getKeys: () => {
      if (unavailable) throw new Error('settings unavailable');
      return [...values.keys()];
    },
  };
  return { settings, values, loseReads: () => { unavailable = true; } };
};

describe('continuous battery plan owner', () => {
  it('skips excessive diagnostic work without evaluating an export candidate', () => {
    const capture = captureDebugTopic('plan');
    const first = { ...horizon.periods[0], durationMs: 900_000, maxChargeKW: 12 };
    const stress: ContinuousBatteryEnergyHorizon = {
      battery: { ...horizon.battery, capacityKWh: 2, storedEnergyKWh: 1, minimumEnergyKWh: 0.4,
        maxChargeKW: 12, maxDischargeKW: 12 },
      periods: [first, ...Array.from({ length: 191 }, (_, index) => ({
        ...first, startsAtMs: NOW + (index + 1) * 900_000,
      }))],
    };
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource({
      getNowMs: () => NOW,
      readHorizon: () => ({ kind: 'ready', horizon: stress, priceUnit: 'EUR/kWh', exportPricing: 'complete' }),
    }));
    const result = owner.read('battery');
    if (result.status !== 'planned') throw new Error('Expected household plan');
    expect(result.plan.periods.every(period => period.gridExportKWh === 0)).toBe(true);
    expect(capture.findEvents('battery_export_shadow_skipped')[0]).toMatchObject({
      reason: 'evaluation_budget_exceeded', mode: 'shadow', maxTransitions: 2_000_000,
    });
    expect(capture.findEvents('battery_export_shadow_evaluated')).toEqual([]);
  });

  it('logs export economics without changing the returned household plan or settings', () => {
    const capture = captureDebugTopic('plan');
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    const tradingHorizon: ContinuousBatteryEnergyHorizon = {
      ...horizon,
      battery: { ...horizon.battery, terminalValuePerKWh: 0.018 },
      periods: [
        { ...horizon.periods[0], importPrice: 0.05, exportPrice: 0.01, householdDemandKWh: 0 },
        { ...horizon.periods[0], startsAtMs: NOW + 3_600_000, importPrice: 0.5, exportPrice: 1, householdDemandKWh: 0 },
      ],
    };
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource({
      getNowMs: () => NOW,
      readHorizon: () => ({ kind: 'ready', horizon: tradingHorizon, priceUnit: 'EUR/kWh', exportPricing: 'complete' }),
    }));
    const result = owner.read('battery');
    if (result.status !== 'planned') throw new Error('Expected household plan');
    expect(result.plan.periods.every(period => period.gridExportKWh === 0 && period.batteryPowerKW >= 0)).toBe(true);
    expect(result).not.toHaveProperty('estimatedSavings');
    expect(store.values.get(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY)).toEqual({ battery: config });
    const [event] = capture.findEvents('battery_export_shadow_evaluated');
    expect(event).toMatchObject({ mode: 'shadow', actuation: 'household_only', selection: 'export_candidate',
      ceilingSource: 'battery_delivery_limit', assumedNetExportCeilingKW: 2.5, priceUnit: 'EUR/kWh' });
    expect(event?.estimatedSavings).toBeGreaterThan(0);
    expect(event?.terminalEnergyKWh).toBe(result.plan.terminalEnergyKWh);
    expect(owner.read('battery')).toBe(result);
    expect(capture.findEvents('battery_export_shadow_evaluated')).toHaveLength(1);
  });

  it('does not produce shadow diagnostics with the plan topic off', () => {
    const capture = captureDebugTopic('plan', { enabled: false });
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    expect(new ContinuousBatteryPlanService(store.settings, perBatterySource(source)).read('battery').status).toBe('planned');
    expect(capture.events()).toEqual([]);
  });

  it('bounds shadow sampling separately from the live plan memo and samples again after a clock rollback', () => {
    const capture = captureDebugTopic('plan');
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    let nowMs = NOW;
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource({ ...source, getNowMs: () => nowMs }));
    owner.read('battery');
    nowMs += 31_000;
    owner.read('battery');
    expect(capture.findEvents('battery_export_shadow_evaluated')).toHaveLength(1);
    nowMs = NOW + 300_000;
    owner.read('battery');
    expect(capture.findEvents('battery_export_shadow_evaluated')).toHaveLength(2);
    nowMs = NOW - 1;
    owner.read('battery');
    expect(capture.findEvents('battery_export_shadow_evaluated')).toHaveLength(3);
  });

  it('keeps household planning for missing export quotes and distinguishes them from an actual zero quote', () => {
    const capture = captureDebugTopic('plan');
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    let exportPricing: 'complete' | 'incomplete' = 'incomplete';
    let nowMs = NOW;
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource({
      getNowMs: () => nowMs,
      readHorizon: () => ({ kind: 'ready', horizon, priceUnit: 'EUR/kWh', exportPricing }),
    }));
    const first = owner.read('battery');
    expect(first.status).toBe('planned');
    expect(capture.findEvents('battery_export_shadow_skipped')[0]).toMatchObject({ reason: 'export_prices_incomplete' });
    expect(capture.findEvents('battery_export_shadow_evaluated')).toHaveLength(0);
    exportPricing = 'complete';
    // Quote completeness participates in the memo even when all numeric prices are still zero.
    expect(owner.read('battery')).not.toBe(first);
    nowMs += 300_000;
    owner.read('battery');
    expect(capture.findEvents('battery_export_shadow_evaluated')[0]).toMatchObject({ selection: 'household', estimatedSavings: 0 });
    exportPricing = 'incomplete';
    nowMs += 300_000;
    owner.read('battery');
    expect(capture.findEvents('battery_export_shadow_skipped')).toHaveLength(2);
    expect(capture.findEvents('battery_export_shadow_evaluated')).toHaveLength(1);
  });

  it('reports whether accepted settings enable any plan as settings change', () => {
    const store = settingsStore();
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource(source));
    expect(owner.hasEnabledPlan()).toBe(false);
    store.settings.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, { battery: { ...config, enabled: false } });
    expect(owner.hasEnabledPlan()).toBe(false);
    store.settings.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, { battery: config });
    expect(owner.hasEnabledPlan()).toBe(true);
    store.settings.unset(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY);
    expect(owner.hasEnabledPlan()).toBe(false);
  });

  it('retains accepted plan enablement through failed reads without enabling a first unreadable plan', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource(source));
    expect(owner.hasEnabledPlan()).toBe(true);
    store.loseReads();
    expect(owner.hasEnabledPlan()).toBe(true);
    const unread = new ContinuousBatteryPlanService(store.settings, perBatterySource(source));
    expect(unread.hasEnabledPlan()).toBe(false);
  });

  it('defaults to disabled only for a genuinely never-written setting', () => {
    const store = settingsStore();
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource(source));
    expect(owner.read('battery')).toEqual({ status: 'disabled', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG });
    store.loseReads();
    const unread = new ContinuousBatteryPlanService(store.settings, perBatterySource(source));
    expect(unread.read('battery')).toMatchObject({ status: 'waiting', reason: 'settings_unavailable' });
  });

  it('never resolves inherited map keys as configured batteries', () => {
    const owner = new ContinuousBatteryPlanService(settingsStore().settings, perBatterySource(source));
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(owner.read(id)).toEqual({ status: 'disabled', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG });
    }
  });

  it('retains the last accepted configuration through a transient settings read failure', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource(source));
    const plan = owner.read('battery');
    expect(plan.status).toBe('planned');
    store.loseReads();
    expect(owner.read('battery')).toBe(plan);
    expect(store.values.get(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY)).toEqual({ battery: config });
  });

  it('accepts settings-channel updates, including a second enabled battery', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource(source));
    expect(owner.read('battery').status).toBe('planned');
    expect(owner.read('other').status).toBe('disabled');
    store.settings.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, { battery: config, other: config });
    expect(owner.read('battery').status).toBe('planned');
    expect(owner.read('other').status).toBe('planned');
    store.settings.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, { battery: { ...config, enabled: false } });
    expect(owner.read('battery').status).toBe('disabled');
  });

  it('stops returning an executable plan when its input becomes unavailable', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    let available = true;
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource({
      getNowMs: () => NOW,
      readHorizon: () => available
        ? { kind: 'ready', exportPricing: 'complete', horizon, priceUnit: 'EUR/kWh' }
        : { kind: 'waiting', reason: 'forecast_unavailable' },
    }));
    expect(owner.read('battery').status).toBe('planned');
    available = false;
    expect(owner.read('battery')).toEqual({ status: 'waiting', config, reason: 'forecast_unavailable' });
  });

  it('reuses a plan while live device draw moves within its tolerance', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    let nowMs = NOW;
    let managedKWh = 0;
    let readings = 0;
    const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource({
      getNowMs: () => nowMs,
      readHorizon: () => {
        readings += 1;
        const durationMs = NOW + 3_600_000 - nowMs;
        return { kind: 'ready', exportPricing: 'complete', priceUnit: 'EUR/kWh', horizon: { ...horizon, periods: [{
          ...horizon.periods[0], startsAtMs: nowMs, durationMs,
          householdDemandKWh: 0.5 * durationMs / 3_600_000,
          otherManagedDemandKWh: managedKWh * durationMs / 3_600_000,
          maxChargeKW: 2.5 - managedKWh,
        }] } };
      },
    }));
    const first = owner.read('battery');
    expect(first.status).toBe('planned');
    for (const [stepMs, drawKW] of [[5_000, 0.1], [10_000, 0.05], [15_000, 0.2]] as const) {
      nowMs = NOW + stepMs;
      managedKWh = drawKW;
      expect(owner.read('battery')).toBe(first);
    }
    managedKWh = 0.4;
    const replanned = owner.read('battery');
    expect(replanned).not.toBe(first);
    // The replan at 15 s ages out after its own 30 s, whatever the draw.
    nowMs = NOW + 46_000;
    managedKWh = 0.45;
    expect(owner.read('battery')).not.toBe(replanned);
    expect(readings).toBe(6);
  });

  it('strictly rejects malformed capacity, reserve, efficiency, price unit and wear', () => {
    for (const invalid of [
      { ...config, usableCapacityKWh: Number.NaN }, { ...config, minimumReservePercent: 100 },
      { ...config, roundTripEfficiency: 0 }, { ...config, wearCostPerKWh: -1 }, { ...config, priceUnit: '' },
    ]) expect(parseContinuousBatteryPlanConfig(invalid)).toBeNull();
    expect(parseContinuousBatteryPlanConfigs({ battery: config, other: { enabled: true } })).toBeNull();
  });

  it('accepts an enabled plan in the unit of Flow prices, and tells a never-enabled default from a settled unit', () => {
    const flow = { ...config, priceUnit: 'price units', wearCostPerKWh: 0.02 };
    expect(parseContinuousBatteryPlanConfig(flow)).toEqual(flow);
    expect(isBatteryPlanUnitSettled(flow)).toBe(true);
    expect(isBatteryPlanUnitSettled({ ...flow, enabled: false })).toBe(false);
    expect(isBatteryPlanUnitSettled(DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG)).toBe(false);
    expect(isBatteryPlanUnitSettled({ ...config, enabled: false })).toBe(true);
  });

  it('resolves a config saved before selling existed to household-only, and refuses a malformed export policy', () => {
    const { exportPolicy: _policy, ...legacy } = config;
    expect(parseContinuousBatteryPlanConfig(legacy)?.exportPolicy).toEqual({ kind: 'household_only' });
    expect(parseContinuousBatteryPlanConfig({ ...config, exportPolicy: { kind: 'price_export', netExportCeilingKW: 3 } })
      ?.exportPolicy).toEqual({ kind: 'price_export', netExportCeilingKW: 3 });
    for (const exportPolicy of [
      { kind: 'price_export' }, { kind: 'price_export', netExportCeilingKW: 0 },
      { kind: 'price_export', netExportCeilingKW: Number.POSITIVE_INFINITY }, { kind: 'sell_everything' }, null,
    ]) expect(parseContinuousBatteryPlanConfig({ ...config, exportPolicy })).toBeNull();
  });
});

describe('selling stored energy', () => {
  const selling: ContinuousBatteryPlanConfig = {
    ...config, exportPolicy: { kind: 'price_export', netExportCeilingKW: 2 },
  };
  // Cheap grid hour, then an hour where export pays far more than the cycle costs.
  const tradingHorizon: ContinuousBatteryEnergyHorizon = {
    ...horizon,
    battery: { ...horizon.battery, terminalValuePerKWh: 0.018 },
    periods: [
      { ...horizon.periods[0], importPrice: 0.05, exportPrice: 0.01, householdDemandKWh: 0 },
      { ...horizon.periods[0], startsAtMs: NOW + 3_600_000, importPrice: 0.5, exportPrice: 1, householdDemandKWh: 0 },
    ],
  };
  const ownerFor = (stored: ContinuousBatteryPlanConfig, readHorizon: PerBatterySourceInput['readHorizon']) => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: stored } });
    return { store, owner: new ContinuousBatteryPlanService(store.settings, perBatterySource({ getNowMs: () => NOW, readHorizon })) };
  };
  /** The export decision of a planned read under a price-export policy. */
  const decisionOf = (read: ContinuousBatteryPlanRead) => {
    if (read.status !== 'planned' || !('exportDecision' in read)) throw new Error('Expected a selling plan read');
    return read.exportDecision;
  };
  const ready = (input: ContinuousBatteryEnergyHorizon, exportPricing: 'complete' | 'incomplete' = 'complete') => (
    () => ({ kind: 'ready' as const, horizon: input, priceUnit: 'EUR/kWh', exportPricing })
  );

  it('executes the export plan only when the owner opted in and it is strictly cheaper', () => {
    const optedIn = ownerFor(selling, ready(tradingHorizon)).owner.read('battery');
    const householdOnly = ownerFor(config, ready(tradingHorizon)).owner.read('battery');
    if (optedIn.status !== 'planned' || householdOnly.status !== 'planned') throw new Error('Expected plans');
    expect(householdOnly).not.toHaveProperty('exportDecision');
    expect(householdOnly.plan.periods.some(period => period.reason === 'export_energy')).toBe(false);
    const decision = decisionOf(optedIn);
    if (decision.kind !== 'selling') throw new Error('Expected a sale');
    expect(decision.estimatedSavings).toBeCloseTo(householdOnly.plan.energyCost - optedIn.plan.energyCost, 9);
    expect(optedIn.plan.terminalEnergyKWh).toBe(householdOnly.plan.terminalEnergyKWh);
    const [cheap, expensive] = optedIn.plan.periods;
    expect(cheap?.reason).toBe('charge_grid');
    expect(expensive).toMatchObject({ reason: 'export_energy' });
    expect(expensive!.gridExportKWh).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('keeps the household plan when selling would not lower the cost', () => {
    const [first, second] = tradingHorizon.periods;
    const flat: ContinuousBatteryEnergyHorizon = { ...tradingHorizon, periods: [
      { ...first, importPrice: 0.2, exportPrice: 0.1 }, { ...second!, importPrice: 0.2, exportPrice: 0.1 },
    ] };
    const read = ownerFor(selling, ready(flat)).owner.read('battery');
    if (read.status !== 'planned') throw new Error('Expected a plan');
    expect(decisionOf(read)).toEqual({ kind: 'kept_household' });
    expect(read.plan.periods.some(period => period.reason === 'export_energy')).toBe(false);
  });

  it('waits to sell, keeping a usable household plan, while export quotes are incomplete', () => {
    const read = ownerFor(selling, ready(tradingHorizon, 'incomplete')).owner.read('battery');
    if (read.status !== 'planned') throw new Error('Expected a household plan');
    expect(decisionOf(read)).toEqual({ kind: 'waiting', reason: 'export_prices_incomplete' });
    expect(read.plan.periods.every(period => period.gridExportKWh === 0)).toBe(true);
  });

  it('replans for the household as soon as the owner turns selling off, without waiting out the memo', () => {
    const { store, owner } = ownerFor(selling, ready(tradingHorizon));
    expect(owner.read('battery')).toMatchObject({ exportDecision: { kind: 'selling' } });
    store.values.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, { battery: config });
    const read = owner.read('battery');
    if (read.status !== 'planned') throw new Error('Expected a plan');
    expect(read).not.toHaveProperty('exportDecision');
    expect(read.plan.periods.some(period => period.reason === 'export_energy')).toBe(false);
  });

  describe('keeping an export decision for its first period', () => {
    const setup = (initial: ContinuousBatteryEnergyHorizon) => {
      let nowMs = NOW;
      let current = initial;
      const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: selling } });
      const owner = new ContinuousBatteryPlanService(store.settings, perBatterySource({
        getNowMs: () => nowMs,
        readHorizon: () => ({ kind: 'ready', horizon: current, priceUnit: 'EUR/kWh', exportPricing: 'complete' }),
      }));
      const planned = () => {
        const read = owner.read('battery');
        if (read.status !== 'planned') throw new Error('Expected a plan');
        return read;
      };
      return {
        planned,
        advance: (ms: number) => { nowMs += ms; },
        set: (next: ContinuousBatteryEnergyHorizon) => { current = next; },
      };
    };
    const withDemand = (horizonIn: ContinuousBatteryEnergyHorizon, kWh: number): ContinuousBatteryEnergyHorizon => {
      const [first, ...rest] = horizonIn.periods;
      return { ...horizonIn, periods: [{ ...first, otherManagedDemandKWh: kWh }, ...rest] };
    };

    it('reuses a sale and its plan through live draw and charge-level churn, without solving it again', () => {
      const home = setup(tradingHorizon);
      const first = home.planned();
      expect(decisionOf(first).kind).toBe('selling');
      for (const [index, kWh] of [0.4, 0.9, 0.1].entries()) {
        home.advance(31_000);
        home.set({ ...withDemand(tradingHorizon, kWh),
          battery: { ...tradingHorizon.battery, storedEnergyKWh: 4 - index * 0.2 } });
        const kept = home.planned();
        expect(decisionOf(kept)).toBe(decisionOf(first));
        expect(kept.plan).toBe(first.plan);
      }
    });

    it('decides again at once when a price changes, and when its first period ends', () => {
      const home = setup(tradingHorizon);
      const first = home.planned();
      home.advance(31_000);
      const [cheap, expensive] = tradingHorizon.periods;
      home.set({ ...tradingHorizon, periods: [cheap, { ...expensive!, exportPrice: 0.02 }] });
      const repriced = home.planned();
      expect(decisionOf(repriced)).toEqual({ kind: 'kept_household' });
      home.set(tradingHorizon);
      home.advance(31_000);
      // Back to the first prices within the same period: those economics decide again.
      expect(decisionOf(home.planned()).kind).toBe('selling');
      home.advance(3_600_000);
      expect(home.planned().plan).not.toBe(first.plan);
    });

    it('does not flip from keeping the energy to selling on a charge-level change within the period', () => {
      const capture = captureLogger('info');
      onTestFinished(() => capture.restore());
      // Full: nothing to recharge before the sale, so selling cannot end at the same charge.
      const full = { ...tradingHorizon, battery: { ...tradingHorizon.battery, storedEnergyKWh: 10 } };
      const home = setup(full);
      expect(decisionOf(home.planned())).toEqual({ kind: 'kept_household' });
      // At 4 kWh selling would pay, but the decision holds for the rest of the period.
      for (let reading = 0; reading < 3; reading += 1) {
        home.advance(31_000);
        home.set({ ...tradingHorizon, battery: { ...tradingHorizon.battery, storedEnergyKWh: reading % 2 ? 10 : 4 } });
        expect(decisionOf(home.planned())).toEqual({ kind: 'kept_household' });
      }
      expect(capture.findEvents('battery_export_decision_changed')).toHaveLength(1);
      home.advance(3_600_000);
      home.set(tradingHorizon);
      expect(decisionOf(home.planned()).kind).toBe('selling');
      expect(capture.findEvents('battery_export_decision_changed')).toHaveLength(2);
    });
  });

  it('logs the selling decision once per change, with its planned export periods', () => {
    const capture = captureLogger('debug', ['plan']);
    onTestFinished(() => capture.restore());
    const { owner } = ownerFor(selling, ready(tradingHorizon));
    owner.read('battery');
    owner.read('battery');
    expect(capture.findEvents('battery_export_shadow_evaluated')).toEqual([]);
    const logs = capture.findEvents('battery_export_decision_changed');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ decision: 'selling', exportPeriodCount: 1, firstExportStartsAtMs: NOW + 3_600_000 });
  });
});
