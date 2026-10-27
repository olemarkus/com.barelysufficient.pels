import type {
  ContinuousBatteryPlanConfig,
  ContinuousBatteryPlanConfigs,
  ContinuousBatteryPlanRead,
} from '../../packages/contracts/src/continuousBatteryPlan';
import {
  parseContinuousBatteryPlanConfig,
  parseContinuousBatteryPlanConfigs,
  CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY,
  DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import type { ContinuousBatteryPlanSource } from '../ports/continuousBatteryPlan';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { ApiRequestError } from '../utils/apiRequestError';
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
    const keys = readSettingsKeyList(this.settings);
    if (keys.status !== 'resolved') return { kind: 'unavailable' };
    if (!keys.keys.includes(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY)) return { kind: 'resolved', configs: {} };
    try {
      const configs = parseContinuousBatteryPlanConfigs(this.settings.get(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY));
      return configs === null ? { kind: 'unavailable' } : { kind: 'resolved', configs };
    } catch { return { kind: 'unavailable' }; }
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
    if (Object.values(accepted.configs).filter(candidate => candidate.enabled).length > 1) {
      this.plans.delete(deviceId);
      return { status: 'waiting', config, reason: 'control_unavailable' };
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

  save(deviceId: string, raw: unknown): ContinuousBatteryPlanConfig {
    if (!deviceId) throw new ApiRequestError('A battery device is required.');
    const config = parseContinuousBatteryPlanConfig(raw);
    if (config === null) {
      throw new ApiRequestError('Enter valid battery capacity, reserve, efficiency and wear allowance.');
    }
    if (config.enabled && config.priceUnit === 'price units') {
      throw new ApiRequestError('Set up electricity prices before enabling the battery plan.');
    }
    if (config.enabled) {
      const horizon = this.source.readHorizon(deviceId, config);
      if (horizon.kind === 'waiting' && horizon.reason === 'price_unit_changed') {
        throw new ApiRequestError('The electricity price unit changed. Review the wear allowance and save again.');
      }
    }
    const stored = this.readSettings();
    if (stored.kind === 'unavailable') throw new ApiRequestError('Battery settings could not be read. Try again.');
    if (config.enabled && Object.entries(stored.configs).some(([id, other]) => id !== deviceId && other.enabled)) {
      throw new ApiRequestError(
        'This prototype plans one home battery at a time. Turn off its plan before enabling another battery.',
      );
    }
    const configs = { ...stored.configs, [deviceId]: config };
    this.settings.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, configs);
    this.lastSettings = { kind: 'resolved', configs };
    this.plans.delete(deviceId);
    return config;
  }
}
