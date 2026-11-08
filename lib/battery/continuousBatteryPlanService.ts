import type { BatteryEnergyPlan, BatteryPriceExportPolicy } from '../../packages/contracts/src/batteryPlan';
import type {
  ContinuousBatteryPlanConfig,
  ContinuousBatteryPlanConfigs,
  ContinuousBatteryPlanRead,
  PlannedContinuousBatteryRead,
} from '../../packages/contracts/src/continuousBatteryPlan';
import {
  DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import { getDebugEmitter, getLogger } from '../logging/logger';
import type { ContinuousBatteryHorizonRead, ContinuousBatteryPlanSource } from '../ports/continuousBatteryPlan';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readContinuousBatteryPlanConfigs } from './continuousBatteryPlanSettings';
import { planBatteryEnergy } from './planning/planBatteryEnergy';
import { ENERGY_EPSILON_KWH } from './planning/batteryEnergyFlow';
import { BatteryExportShadow } from './batteryExportShadow';
import { FleetExportTerms, selectBatteryExportPlan, type BatteryExportSelection } from './batteryExportSelection';

type SettingsRead = { kind: 'resolved'; configs: ContinuousBatteryPlanConfigs } | { kind: 'unavailable' };
type HouseholdPlan = Extract<BatteryEnergyPlan, { status: 'planned' }>;
type ExportMemo = { key: string; atMs: number; validUntilMs: number; selection: BatteryExportSelection };
type HorizonRead = ContinuousBatteryHorizonRead;
type ReadyHorizon = Extract<HorizonRead, { kind: 'ready' }>;
type FleetBattery = { deviceId: string; config: ContinuousBatteryPlanConfig; input: ReadyHorizon };
/** One battery's part of the fleet's inputs: what it planned from, or why it waits. */
type BatteryInputs = { deviceId: string; inputs: PlanInputs } | { deviceId: string; waiting: string };
/**
 * Every enabled battery's read, made together and kept together: a battery
 * plans on what the ones before it left, so no read outlives the fleet's.
 */
type FleetMemo = {
  inputs: readonly BatteryInputs[];
  atMs: number;
  validUntilMs: number;
  reads: ReadonlyMap<string, ContinuousBatteryPlanRead>;
};
const PLAN_MEMO_MAX_AGE_MS = 30_000;
const emitDebug = getDebugEmitter('battery', 'price');

/** What the battery page shows of a read: its status and, while waiting, why; and what selling decided. */
type ReadStanding = { status: ContinuousBatteryPlanRead['status']; reason: string | null; selling: string | null };

const sellingOf = (read: ContinuousBatteryPlanRead): string | null => {
  if (read.status !== 'planned' || !('exportDecision' in read)) return null;
  const { exportDecision } = read;
  return exportDecision.kind === 'waiting' ? `waiting:${exportDecision.reason}` : exportDecision.kind;
};

const standingOf = (read: ContinuousBatteryPlanRead): ReadStanding => (
  { status: read.status, reason: read.status === 'waiting' ? read.reason : null, selling: sellingOf(read) }
);
/**
 * Live device draw and the charge room it leaves move on nearly every meter
 * reading. A plan stays valid while they move less than this from the inputs it
 * was made from; the live storage rules cap each command by measured headroom
 * in between. Without it every reading replanned the whole horizon.
 */
const LIVE_POWER_TOLERANCE_KW = 0.25;

/** The inputs a plan was made from: exact economics and energy, and the live power rates it tolerates. */
type PlanInputs = { exact: string; livePowerKW: number[] };

const toKW = (energyKWh: number, durationMs: number): number => energyKWh * 3_600_000 / durationMs;

/** Passage through a partial period alone does not change its economic inputs.
 * Preserve power rates and end boundaries, so a quiet battery can reuse a plan
 * for at most 30 seconds; any SoC, forecast, task, price or reserve change
 * invalidates it, and live power within the tolerance does not. */
const planInputs = (input: ReadyHorizon, config: ContinuousBatteryPlanConfig): PlanInputs => {
  const { battery, periods } = input.horizon;
  const { maxChargeKW, ...exactBattery } = battery;
  return {
    exact: JSON.stringify({
      exportPolicy: config.exportPolicy,
      priceUnit: input.priceUnit,
      exportPricing: input.exportPricing,
      battery: exactBattery,
      periods: periods.map(period => ({
        endMs: period.startsAtMs + period.durationMs,
        importPrice: period.importPrice,
        exportPrice: period.exportPrice,
        backgroundKW: Number(toKW(period.householdDemandKWh, period.durationMs).toFixed(8)),
        solarKW: Number(toKW(period.solarKWh, period.durationMs).toFixed(8)),
      })),
    }),
    livePowerKW: [maxChargeKW, ...periods.flatMap(period => [
      toKW(period.otherManagedDemandKWh, period.durationMs), period.gridImportLimitKW, period.maxChargeKW,
    ])],
  };
};

/**
 * The exact economics an export decision rests on: the owner's policy, the price
 * unit and quote coverage, the battery's economics, and each period's end and
 * prices. Period ends move with smart-task reservation boundaries. The charge
 * level, live device draw and power limits are not in it: they move on nearly
 * every reading, and the storage lane bounds each command by measurement.
 */
const exportEconomicsKey = (input: ReadyHorizon, policy: BatteryPriceExportPolicy): string => {
  const direction = (kWh: number): number => (Math.abs(kWh) <= ENERGY_EPSILON_KWH ? 0 : Math.sign(kWh));
  const {
    capacityKWh, minimumEnergyKWh, roundTripEfficiency, wearCostPerKWh, terminalValuePerKWh,
  } = input.horizon.battery;
  return JSON.stringify({
    policy,
    priceUnit: input.priceUnit,
    exportPricing: input.exportPricing,
    battery: { capacityKWh, minimumEnergyKWh, roundTripEfficiency, wearCostPerKWh, terminalValuePerKWh },
    // Which way the batteries planned before this one move in each period
    // bounds which way this one may: a sale decided against other directions
    // is decided again.
    periods: input.horizon.periods.map(period => [
      period.startsAtMs + period.durationMs, period.importPrice, period.exportPrice, direction(period.otherStorageKWh),
    ]),
  });
};

const sameInputs = (made: readonly BatteryInputs[], current: readonly BatteryInputs[]): boolean => (
  made.length === current.length && made.every((battery, index) => {
    const now = current[index];
    if (now === undefined || now.deviceId !== battery.deviceId) return false;
    if ('waiting' in battery || 'waiting' in now) {
      return 'waiting' in battery && 'waiting' in now && battery.waiting === now.waiting;
    }
    return withinTolerance(battery.inputs, now.inputs);
  })
);

/**
 * A battery's horizon after the batteries planned before it: their energy is
 * part of its demand and sets each period's direction, their charge takes
 * from its charging room, and the batteries after it may cover import it
 * leaves above the limit.
 */
const followingHorizon = (
  input: ReadyHorizon,
  otherStorageKWh: readonly number[],
  otherChargeKW: readonly number[],
  laterSupplyKW: number,
): ReadyHorizon => {
  const [first, ...rest] = input.horizon.periods.map((period, index) => ({
    ...period,
    otherStorageKWh: otherStorageKWh[index] ?? 0,
    maxChargeKW: Math.max(0, period.maxChargeKW - (otherChargeKW[index] ?? 0)),
    laterSupplyKW,
  }));
  if (first === undefined) throw new Error('A ready battery horizon has periods');
  return { ...input, horizon: { ...input.horizon, periods: [first, ...rest] } };
};

const withinTolerance = (made: PlanInputs, current: PlanInputs): boolean => (
  made.exact === current.exact && made.livePowerKW.length === current.livePowerKW.length
  && made.livePowerKW.every((kw, index) => {
    const now = current.livePowerKW[index];
    return now !== undefined && Math.abs(kw - now) < LIVE_POWER_TOLERANCE_KW;
  })
);

/**
 * Continuous-plan configuration, economic planning and bounded memo belong to
 * this battery owner. Every enabled battery plans together, in the owner's
 * priority order: each on what the batteries before it left.
 */
export class ContinuousBatteryPlanService {
  private lastSettings: SettingsRead = { kind: 'unavailable' };
  private fleet: FleetMemo | undefined;
  private readonly standings = new Map<string, ReadStanding>();
  private readonly exportShadow = new BatteryExportShadow();
  private readonly exportMemos = new Map<string, ExportMemo>();

  constructor(private readonly settings: SettingsPort, private readonly source: ContinuousBatteryPlanSource) {}

  private readSettings(): SettingsRead {
    const configs = readContinuousBatteryPlanConfigs(this.settings);
    return configs === null ? { kind: 'unavailable' } : { kind: 'resolved', configs };
  }

  private acceptedSettings(): SettingsRead {
    const next = this.readSettings();
    if (next.kind === 'resolved') {
      this.lastSettings = next;
      for (const id of this.exportMemos.keys()) if (!next.configs[id]?.enabled) this.exportMemos.delete(id);
    }
    return this.lastSettings;
  }

  /** An accepted enabled plan starts sampling; failed reads retain the last accepted configuration. */
  hasEnabledPlan(): boolean {
    const accepted = this.acceptedSettings();
    return accepted.kind === 'resolved' && Object.values(accepted.configs).some(config => config.enabled);
  }

  /**
   * The battery plan read for one battery. A change of its status or waiting
   * reason, which otherwise reaches only the battery page, is logged once.
   */
  read(deviceId: string): ContinuousBatteryPlanRead {
    const read = this.resolveRead(deviceId);
    this.logStandingChange(deviceId, read);
    return read;
  }
  private logStandingChange(deviceId: string, read: ContinuousBatteryPlanRead): void {
    const next = standingOf(read);
    const previous = this.standings.get(deviceId);
    const statusChanged = previous?.status !== next.status || previous.reason !== next.reason;
    const sellingChanged = (previous?.selling ?? null) !== next.selling;
    if (!statusChanged && !sellingChanged) return;
    this.standings.set(deviceId, next);
    if (statusChanged) {
      emitDebug({
        event: 'battery_plan_status_changed',
        deviceId,
        status: next.status,
        reason: next.reason,
        previousStatus: previous?.status ?? null,
        previousReason: previous?.reason ?? null,
      });
    }
    if (read.status === 'planned' && sellingChanged) this.logSellingChange(deviceId, read);
  }

  /**
   * The selling decision and its planned export periods, once per change, for
   * the activity log; `household_only` when the owner turned selling off.
   */
  private logSellingChange(deviceId: string, read: PlannedContinuousBatteryRead): void {
    const exportPeriods = read.plan.periods.filter(period => period.reason === 'export_energy');
    const decision = 'exportDecision' in read ? read.exportDecision : null;
    getLogger('battery').info({
      event: 'battery_export_decision_changed',
      deviceId,
      decision: decision?.kind ?? 'household_only',
      waitingReason: decision?.kind === 'waiting' ? decision.reason : null,
      estimatedSavings: decision?.kind === 'selling' ? decision.estimatedSavings : null,
      priceUnit: read.priceUnit,
      exportPeriodCount: exportPeriods.length,
      firstExportStartsAtMs: exportPeriods[0]?.startsAtMs ?? null,
    });
  }

  private resolveRead(deviceId: string): ContinuousBatteryPlanRead {
    const accepted = this.acceptedSettings();
    if (accepted.kind === 'unavailable') {
      return { status: 'waiting', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, reason: 'settings_unavailable' };
    }
    const storedConfig = Object.hasOwn(accepted.configs, deviceId)
      ? accepted.configs[deviceId]
      : undefined;
    const config = storedConfig ?? DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG;
    if (!config.enabled) return { status: 'disabled', config };
    const read = this.fleetReads(accepted.configs).get(deviceId);
    if (read === undefined) throw new Error('Every enabled battery has a fleet read');
    return read;
  }

  /**
   * Every enabled battery's read. Every consumed input participates: current
   * SoC, partial period, prices and forecasts must match exactly. Live device
   * draw, task reservations and the charge room and import limit they leave
   * may move within the tolerance, for at most the memo's age; storage rules
   * cap each command by live headroom. One fleet entry; no revision history.
   */
  private fleetReads(configs: ContinuousBatteryPlanConfigs): ReadonlyMap<string, ContinuousBatteryPlanRead> {
    const enabledIds = Object.keys(configs).filter(id => configs[id]?.enabled === true);
    const order = this.source.orderByPriority(enabledIds);
    const batteries = order.map((deviceId) => {
      const config = configs[deviceId];
      if (config === undefined) throw new Error('An ordered battery has a config');
      return { deviceId, config };
    });
    const nowMs = this.source.getNowMs();
    const horizons = this.source.readHorizons(nowMs, batteries);
    const inputs: BatteryInputs[] = batteries.map(({ deviceId, config }) => {
      const horizon = horizons.get(deviceId);
      if (horizon === undefined) throw new Error('Every enabled battery has a horizon read');
      return horizon.kind === 'waiting'
        ? { deviceId, waiting: horizon.reason }
        : { deviceId, inputs: planInputs(horizon, config) };
    });
    const previous = this.fleet;
    if (previous !== undefined && sameInputs(previous.inputs, inputs) && nowMs >= previous.atMs
      && nowMs - previous.atMs < PLAN_MEMO_MAX_AGE_MS && nowMs < previous.validUntilMs) return previous.reads;
    const reads = this.planFleet(batteries, horizons, nowMs);
    const firstReady = [...horizons.values()].find(horizon => horizon.kind === 'ready');
    this.fleet = {
      inputs, atMs: nowMs, reads,
      validUntilMs: firstReady?.kind === 'ready'
        ? firstReady.horizon.periods[0].startsAtMs + firstReady.horizon.periods[0].durationMs
        : nowMs,
    };
    return reads;
  }

  /**
   * Plan the ready batteries one after another. Each plans with its own
   * economics against the house the earlier ones left, and the ones after it
   * may cover import it cannot; the last plans against the limit alone, as a
   * single battery does. A later battery that cannot cover all the earlier
   * ones left covers what it can: the rest stays on the grid, where power-limit
   * control handles it, rather than leaving that battery unplanned.
   */
  private planFleet(
    batteries: readonly { deviceId: string; config: ContinuousBatteryPlanConfig }[],
    horizons: ReadonlyMap<string, HorizonRead>,
    nowMs: number,
  ): ReadonlyMap<string, ContinuousBatteryPlanRead> {
    const reads = new Map<string, ContinuousBatteryPlanRead>();
    const ready = batteries.flatMap(({ deviceId, config }): FleetBattery[] => {
      const horizon = horizons.get(deviceId);
      if (horizon?.kind === 'ready') return [{ deviceId, config, input: horizon }];
      if (horizon?.kind === 'waiting') reads.set(deviceId, { status: 'waiting', config, reason: horizon.reason });
      return [];
    });
    const supplyKW = (fleet: readonly FleetBattery[]): number => (
      fleet.reduce((total, battery) => total + battery.input.horizon.battery.maxDischargeKW, 0)
    );
    // The most import any battery may have left above the limit for others.
    const deferrableKW = supplyKW(ready.slice(1));
    // Every battery allowed to sell counts, ready or not: the limit is the
    // Main meter's, and one battery waiting does not loosen it.
    const ceilings = batteries.flatMap(({ config }) => (
      config.exportPolicy.kind === 'price_export' ? [config.exportPolicy.netExportCeilingKW] : []
    ));
    const exportTerms = new FleetExportTerms(ceilings.length === 0 ? 0 : Math.min(...ceilings));
    const periodCount = ready[0]?.input.horizon.periods.length ?? 0;
    const otherStorageKWh = new Array<number>(periodCount).fill(0);
    const otherChargeKW = new Array<number>(periodCount).fill(0);
    ready.forEach(({ deviceId, config, input }, index) => {
      let following = followingHorizon(input, otherStorageKWh, otherChargeKW, supplyKW(ready.slice(index + 1)));
      let household = planBatteryEnergy(following.horizon);
      if (household.status !== 'planned' && index > 0) {
        following = followingHorizon(input, otherStorageKWh, otherChargeKW, deferrableKW);
        household = planBatteryEnergy(following.horizon);
      }
      if (household.status !== 'planned') {
        reads.set(deviceId, { status: 'waiting', config, reason: 'horizon_infeasible' });
        return;
      }
      const read = this.plannedRead(deviceId, following, config, household, nowMs, exportTerms);
      reads.set(deviceId, read);
      read.plan.periods.forEach((period, periodIndex) => {
        const energyKWh = period.batteryPowerKW * period.durationMs / 3_600_000;
        otherStorageKWh[periodIndex] = (otherStorageKWh[periodIndex] ?? 0) + energyKWh;
        otherChargeKW[periodIndex] = (otherChargeKW[periodIndex] ?? 0) + Math.max(0, period.batteryPowerKW);
      });
    });
    return reads;
  }

  /**
   * The executable plan. Household-only planning never sells; its diagnostic
   * shadow only logs, and never replaces the household plan. An owner who
   * authorized selling gets the complete-plan comparison instead.
   */
  private plannedRead(
    deviceId: string,
    input: ReadyHorizon,
    config: ContinuousBatteryPlanConfig,
    household: HouseholdPlan,
    nowMs: number,
    exportTerms: FleetExportTerms,
  ): PlannedContinuousBatteryRead {
    const common = {
      status: 'planned' as const, generatedAtMs: nowMs, priceUnit: input.priceUnit,
      unpricedSolarExport: input.exportPricing === 'unpriced_solar',
    };
    const policy = config.exportPolicy;
    if (policy.kind === 'household_only') {
      this.exportMemos.delete(deviceId);
      this.exportShadow.observe(deviceId, input, household, nowMs);
      return { ...common, config: { ...config, exportPolicy: policy }, plan: household };
    }
    const selection = this.selectExport(deviceId, input, household, nowMs, exportTerms);
    return {
      ...common, config: { ...config, exportPolicy: policy }, plan: selection.plan, exportDecision: selection.decision,
    };
  }

  /**
   * The export decision, kept for the rest of its first period while the
   * horizon's economics stay exactly as they were (`exportEconomicsKey`). The
   * comparison is a second full solve; live device draw and the battery's own
   * charge level move on nearly every meter reading, and re-deciding on that
   * churn would both cost a solve per memo miss and flip a sale on and off near
   * the comparison's tolerance. A kept sale keeps its plan; a kept household
   * decision uses the household plan just solved.
   */
  private selectExport(
    deviceId: string,
    input: ReadyHorizon,
    household: HouseholdPlan,
    nowMs: number,
    exportTerms: FleetExportTerms,
  ): BatteryExportSelection {
    const key = exportEconomicsKey(input, exportTerms.policy);
    const kept = this.exportMemos.get(deviceId);
    if (kept !== undefined && kept.key === key && nowMs >= kept.atMs && nowMs < kept.validUntilMs) {
      return kept.selection.decision.kind === 'selling'
        ? kept.selection
        : { plan: household, decision: kept.selection.decision };
    }
    const selection = selectBatteryExportPlan(input, household, exportTerms);
    // A wait for the shared work bound depends on what the other batteries
    // spent this plan: it is decided again next plan, not kept.
    if (selection.decision.kind === 'waiting' && selection.decision.reason === 'evaluation_budget_exceeded') {
      this.exportMemos.delete(deviceId);
      return selection;
    }
    const first = input.horizon.periods[0];
    this.exportMemos.set(deviceId, { key, atMs: nowMs, validUntilMs: first.startsAtMs + first.durationMs, selection });
    return selection;
  }
}
