import type {
  ContinuousBatteryPlanConfigs,
  ContinuousBatteryPlanRead,
} from '../../packages/contracts/src/continuousBatteryPlan';
import {
  DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import type { ContinuousBatteryPlanSource } from '../ports/continuousBatteryPlan';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readContinuousBatteryPlanConfigs } from './continuousBatteryPlanSettings';
import { planBatteryEnergy } from './planning/planBatteryEnergy';

type SettingsRead = { kind: 'resolved'; configs: ContinuousBatteryPlanConfigs } | { kind: 'unavailable' };
type PlanMemo = { inputs: PlanInputs; atMs: number; validUntilMs: number; read: ContinuousBatteryPlanRead };
type ReadyHorizon = Extract<ReturnType<ContinuousBatteryPlanSource['readHorizon']>, { kind: 'ready' }>;
const PLAN_MEMO_MAX_AGE_MS = 30_000;
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
const planInputs = (input: ReadyHorizon): PlanInputs => {
  const { battery, periods } = input.horizon;
  const { maxChargeKW, ...exactBattery } = battery;
  return {
    exact: JSON.stringify({
      priceUnit: input.priceUnit,
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
    }
    return this.lastSettings;
  }

  /** An accepted enabled plan starts sampling; failed reads retain the last accepted configuration. */
  hasEnabledPlan(): boolean {
    const accepted = this.acceptedSettings();
    return accepted.kind === 'resolved' && Object.values(accepted.configs).some(config => config.enabled);
  }

  read(deviceId: string): ContinuousBatteryPlanRead {
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
    const inputs = planInputs(input);
    const nowMs = this.source.getNowMs();
    const previous = this.plans.get(deviceId);
    if (previous !== undefined && withinTolerance(previous.inputs, inputs) && nowMs >= previous.atMs
      && nowMs - previous.atMs < PLAN_MEMO_MAX_AGE_MS && nowMs < previous.validUntilMs) return previous.read;
    const plan = planBatteryEnergy(input.horizon);
    const read: ContinuousBatteryPlanRead = plan.status === 'planned'
      ? { status: 'planned', config, generatedAtMs: this.source.getNowMs(), priceUnit: input.priceUnit, plan }
      : { status: 'waiting', config, reason: 'horizon_infeasible' };
    this.plans.set(deviceId, {
      inputs, atMs: nowMs,
      validUntilMs: input.horizon.periods[0].startsAtMs + input.horizon.periods[0].durationMs,
      read,
    });
    return read;
  }

}
