import type { BatteryEnergyPlan } from '../../packages/contracts/src/batteryPlan';
import type { ContinuousBatteryHorizonRead } from '../ports/continuousBatteryPlan';
import { getDebugEmitter, getLogger, isDebugTopicEnabled } from '../logging/logger';
import { compareBatteryExportEconomics, estimateBatteryEnergyTransitions } from './planning/planBatteryEnergy';

type ReadyHorizon = Extract<ContinuousBatteryHorizonRead, { kind: 'ready' }>;
type HouseholdPlan = Extract<BatteryEnergyPlan, { status: 'planned' }>;
const SAMPLE_INTERVAL_MS = 5 * 60_000;
const MAX_SHADOW_TRANSITIONS = 2_000_000;

/** Diagnostic snapshots, never an executable plan or a cumulative savings ledger.
 * Only the existing plan debug topic enables the extra solve. The assumed net
 * export ceiling is the current battery delivery limit, not owner permission.
 * One battery can be enabled, so only its latest sample time is retained. */
export class BatteryExportShadow {
  private sampled: { deviceId: string; atMs: number } | undefined;

  observe(deviceId: string, input: ReadyHorizon, baseline: HouseholdPlan, nowMs: number): void {
    if (!isDebugTopicEnabled('plan')) {
      this.sampled = undefined;
      return;
    }
    if (this.sampled?.deviceId === deviceId && nowMs >= this.sampled.atMs
      && nowMs - this.sampled.atMs < SAMPLE_INTERVAL_MS) return;
    this.sampled = { deviceId, atMs: nowMs };
    const emit = getDebugEmitter('battery', 'plan');
    const netExportCeilingKW = input.horizon.battery.maxDischargeKW;
    const sample = {
      deviceId, mode: 'shadow', actuation: 'household_only', sampledAtMs: nowMs,
      priceUnit: input.priceUnit, assumedNetExportCeilingKW: netExportCeilingKW,
      ceilingSource: 'battery_delivery_limit',
      horizonStartsAtMs: input.horizon.periods[0].startsAtMs,
      horizonEndsAtMs: input.horizon.periods.reduce((endMs, period) => (
        Math.max(endMs, period.startsAtMs + period.durationMs)
      ), input.horizon.periods[0].startsAtMs),
    };
    if (input.exportPricing === 'incomplete' || netExportCeilingKW <= 0) {
      emit({ event: 'battery_export_shadow_skipped', ...sample,
        reason: input.exportPricing === 'incomplete' ? 'export_prices_incomplete' : 'discharge_unavailable' });
      return;
    }
    const estimatedTransitions = estimateBatteryEnergyTransitions(input.horizon);
    if (estimatedTransitions > MAX_SHADOW_TRANSITIONS) {
      emit({ event: 'battery_export_shadow_skipped', ...sample, reason: 'evaluation_budget_exceeded',
        estimatedTransitions, maxTransitions: MAX_SHADOW_TRANSITIONS });
      return;
    }
    const startedAt = performance.now();
    try {
      const comparison = compareBatteryExportEconomics(input.horizon,
        { kind: 'price_export', netExportCeilingKW }, baseline);
      emit({ event: 'battery_export_shadow_evaluated', ...sample, ...comparison,
        estimatedTransitions, evaluationDurationMs: performance.now() - startedAt });
    } catch (err) {
      // An experimental diagnostic must not prevent the accepted household plan
      // from reaching control. Surface the failure rather than inventing savings.
      getLogger('battery').warn({ event: 'battery_export_shadow_failed', ...sample, err });
    }
  }
}
