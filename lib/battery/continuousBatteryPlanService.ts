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
type PlanMemo = { signature: string; atMs: number; validUntilMs: number; read: ContinuousBatteryPlanRead };
type ReadyHorizon = Extract<ReturnType<ContinuousBatteryPlanSource['readHorizon']>, { kind: 'ready' }>;
const PLAN_MEMO_MAX_AGE_MS = 30_000;

/** Passage through a partial period alone does not change its economic inputs.
 * Preserve power rates and end boundaries, so a quiet battery can reuse a plan
 * for at most 30 seconds; any SoC, forecast, task, price or limit change invalidates it. */
const horizonSignature = (input: ReadyHorizon): string => (
  JSON.stringify({
    priceUnit: input.priceUnit,
    battery: input.horizon.battery,
    periods: input.horizon.periods.map(period => ({
      endMs: period.startsAtMs + period.durationMs,
      importPrice: period.importPrice,
      exportPrice: period.exportPrice,
      backgroundKW: Number((period.householdDemandKWh * 3_600_000 / period.durationMs).toFixed(8)),
      managedKW: Number((period.otherManagedDemandKWh * 3_600_000 / period.durationMs).toFixed(8)),
      solarKW: Number((period.solarKWh * 3_600_000 / period.durationMs).toFixed(8)),
      gridImportLimitKW: period.gridImportLimitKW,
      maxChargeKW: period.maxChargeKW,
    })),
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
    // Every consumed input participates: current SoC, partial period, prices,
    // forecasts, task commitments and limits cannot leave an old command alive.
    // One entry per configured device; no accumulated revision history.
    const signature = horizonSignature(input);
    const nowMs = this.source.getNowMs();
    const previous = this.plans.get(deviceId);
    if (previous?.signature === signature && nowMs >= previous.atMs
      && nowMs - previous.atMs < PLAN_MEMO_MAX_AGE_MS && nowMs < previous.validUntilMs) return previous.read;
    const plan = planBatteryEnergy(input.horizon);
    const read: ContinuousBatteryPlanRead = plan.status === 'planned'
      ? { status: 'planned', config, generatedAtMs: this.source.getNowMs(), priceUnit: input.priceUnit, plan }
      : { status: 'waiting', config, reason: 'horizon_infeasible' };
    this.plans.set(deviceId, {
      signature, atMs: nowMs,
      validUntilMs: input.horizon.periods[0].startsAtMs + input.horizon.periods[0].durationMs,
      read,
    });
    return read;
  }

}
