import type { BatteryEnergyPlan } from '../../packages/contracts/src/batteryPlan';
import type { ContinuousBatteryHorizonRead } from '../ports/continuousBatteryPlan';
import { getDebugEmitter, getLogger, isDebugTopicEnabled } from '../logging/logger';
import { compareBatteryExportEconomics, estimateBatteryEnergyTransitions } from './planning/planBatteryEnergy';
import { MAX_EXPORT_COMPARISON_TRANSITIONS as MAX_SHADOW_TRANSITIONS } from './batteryExportSelection';

type ReadyHorizon = Extract<ContinuousBatteryHorizonRead, { kind: 'ready' }>;
type HouseholdPlan = Extract<BatteryEnergyPlan, { status: 'planned' }>;
const SAMPLE_INTERVAL_MS = 5 * 60_000;

/** Diagnostic snapshots, never an executable plan or a cumulative savings ledger.
 * It runs only for a household-only battery (an owner who authorized selling
 * gets the real comparison instead), and only the existing plan debug topic
 * enables the extra solve. The assumed net
 * export ceiling is the current battery delivery limit, not owner permission.
 * Each battery keeps only its latest sample time. */
export class BatteryExportShadow {
  private readonly sampledAtMs = new Map<string, number>();

  observe(deviceId: string, input: ReadyHorizon, baseline: HouseholdPlan, nowMs: number): void {
    if (!isDebugTopicEnabled('plan')) {
      this.sampledAtMs.clear();
      return;
    }
    const sampledAtMs = this.sampledAtMs.get(deviceId);
    if (sampledAtMs !== undefined && nowMs >= sampledAtMs && nowMs - sampledAtMs < SAMPLE_INTERVAL_MS) return;
    this.sampledAtMs.set(deviceId, nowMs);
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
    if (input.exportPricing !== 'complete' || netExportCeilingKW <= 0) {
      emit({ event: 'battery_export_shadow_skipped', ...sample,
        reason: input.exportPricing !== 'complete' ? 'export_prices_incomplete' : 'discharge_unavailable' });
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
      // The diagnostic logs the comparison, never the candidate schedule itself.
      const evidence = comparison.kind === 'compared'
        ? (({ candidate: _plan, ...rest }) => rest)(comparison)
        : comparison;
      emit({ event: 'battery_export_shadow_evaluated', ...sample, ...evidence,
        estimatedTransitions, evaluationDurationMs: performance.now() - startedAt });
    } catch (err) {
      // An experimental diagnostic must not prevent the accepted household plan
      // from reaching control. Surface the failure rather than inventing savings.
      getLogger('battery').warn({ event: 'battery_export_shadow_failed', ...sample, err });
    }
  }
}
