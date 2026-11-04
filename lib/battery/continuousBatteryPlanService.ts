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
import type { ContinuousBatteryPlanSource } from '../ports/continuousBatteryPlan';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readContinuousBatteryPlanConfigs } from './continuousBatteryPlanSettings';
import { planBatteryEnergy } from './planning/planBatteryEnergy';
import { BatteryExportShadow } from './batteryExportShadow';
import { selectBatteryExportPlan, type BatteryExportSelection } from './batteryExportSelection';

type SettingsRead = { kind: 'resolved'; configs: ContinuousBatteryPlanConfigs } | { kind: 'unavailable' };
type PlanMemo = { inputs: PlanInputs; atMs: number; validUntilMs: number; read: ContinuousBatteryPlanRead };
type HouseholdPlan = Extract<BatteryEnergyPlan, { status: 'planned' }>;
type ExportMemo = { key: string; atMs: number; validUntilMs: number; selection: BatteryExportSelection };
type ReadyHorizon = Extract<ReturnType<ContinuousBatteryPlanSource['readHorizon']>, { kind: 'ready' }>;
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
  const {
    capacityKWh, minimumEnergyKWh, roundTripEfficiency, wearCostPerKWh, terminalValuePerKWh,
  } = input.horizon.battery;
  return JSON.stringify({
    policy,
    priceUnit: input.priceUnit,
    exportPricing: input.exportPricing,
    battery: { capacityKWh, minimumEnergyKWh, roundTripEfficiency, wearCostPerKWh, terminalValuePerKWh },
    periods: input.horizon.periods.map(period => [
      period.startsAtMs + period.durationMs, period.importPrice, period.exportPrice,
    ]),
  });
};

const withinTolerance = (made: PlanInputs, current: PlanInputs): boolean => (
  made.exact === current.exact && made.livePowerKW.length === current.livePowerKW.length
  && made.livePowerKW.every((kw, index) => {
    const now = current.livePowerKW[index];
    return now !== undefined && Math.abs(kw - now) < LIVE_POWER_TOLERANCE_KW;
  })
);

/** Continuous-plan configuration, economic planning and bounded memo belong to this battery owner. */
export class ContinuousBatteryPlanService {
  private lastSettings: SettingsRead = { kind: 'unavailable' };
  private readonly plans = new Map<string, PlanMemo>();
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
      for (const id of this.plans.keys()) if (!next.configs[id]?.enabled) this.plans.delete(id);
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
    if (!config.enabled) {
      this.plans.delete(deviceId);
      return { status: 'disabled', config };
    }
    const input = this.source.readHorizon(deviceId, config);
    if (input.kind === 'waiting') {
      this.plans.delete(deviceId);
      return { status: 'waiting', config, reason: input.reason };
    }
    // Every consumed input participates: current SoC, partial period, prices and
    // forecasts must match exactly. Live device draw, task reservations and the
    // charge room and import limit they leave may move within the tolerance, for
    // at most the memo's age; storage rules cap each command by live headroom.
    // One entry per configured device; no accumulated revision history.
    const inputs = planInputs(input, config);
    const nowMs = this.source.getNowMs();
    const previous = this.plans.get(deviceId);
    if (previous !== undefined && withinTolerance(previous.inputs, inputs) && nowMs >= previous.atMs
      && nowMs - previous.atMs < PLAN_MEMO_MAX_AGE_MS && nowMs < previous.validUntilMs) return previous.read;
    const household = planBatteryEnergy(input.horizon);
    const read: ContinuousBatteryPlanRead = household.status === 'planned'
      ? this.plannedRead(deviceId, input, config, household, nowMs)
      : { status: 'waiting', config, reason: 'horizon_infeasible' };
    this.plans.set(deviceId, {
      inputs, atMs: nowMs,
      validUntilMs: input.horizon.periods[0].startsAtMs + input.horizon.periods[0].durationMs,
      read,
    });
    return read;
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
    const selection = this.selectExport(deviceId, input, policy, household, nowMs);
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
    policy: BatteryPriceExportPolicy,
    household: HouseholdPlan,
    nowMs: number,
  ): BatteryExportSelection {
    const key = exportEconomicsKey(input, policy);
    const kept = this.exportMemos.get(deviceId);
    if (kept !== undefined && kept.key === key && nowMs >= kept.atMs && nowMs < kept.validUntilMs) {
      return kept.selection.decision.kind === 'selling'
        ? kept.selection
        : { plan: household, decision: kept.selection.decision };
    }
    const selection = selectBatteryExportPlan(input, policy, household);
    const first = input.horizon.periods[0];
    this.exportMemos.set(deviceId, { key, atMs: nowMs, validUntilMs: first.startsAtMs + first.durationMs, selection });
    return selection;
  }
}
