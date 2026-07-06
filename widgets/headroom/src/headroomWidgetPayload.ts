import type { HeadroomWidgetLimitState } from '../../../packages/shared-domain/src/headroomWidgetCopy';
import { EMPTY_SUBTITLE_DEFAULT } from './headroomWidgetConstants';
import type {
  HeadroomWidgetEmptyPayload,
  HeadroomWidgetPayload,
  HeadroomWidgetPriceLevel,
  HeadroomWidgetReadyPayload,
} from './headroomWidgetTypes';

const STALE_AFTER_MS = 90 * 1000;
const NEAR_PACE_RATIO = 0.85;
// Re-exported from the browser-safe constants module so existing consumers
// and tests keep a stable import surface off the builder.
export { EMPTY_SUBTITLE_DEFAULT };

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const resolvePriceLevel = (value: unknown): HeadroomWidgetPriceLevel => {
  if (value === 'cheap') return 'cheap';
  if (value === 'expensive') return 'expensive';
  if (value === 'normal') return 'normal';
  return 'unknown';
};

export type HeadroomWidgetInput = {
  status: {
    headroomKw?: number;
    hourlyLimitKw?: number;
    projectedOverHardCap?: boolean;
    controlledKw?: number;
    uncontrolledKw?: number;
    devicesOff?: number;
    priceLevel?: unknown;
    lastPowerUpdate?: number | null;
    powerKnown?: boolean;
  } | null;
  nowMs?: number;
};

/**
 * Resolve the at-limit state so the renderer reads a flat enum instead of
 * re-deriving kW thresholds. `over_cap` — the only red/danger state — is the
 * producer-resolved TRAJECTORY flag (projected this-hour energy past the hard
 * cap's hourly kWh, `lib/plan/pelsStatus.ts`), never instantaneous kW vs the
 * cap: the cap is an hourly-average tariff-step ceiling, so a momentary draw
 * above it is not an exceedance. Sitting at the dynamic safe pace is correct
 * operation and reads as the calmer `at_pace` state.
 */
const resolveLimitState = (params: {
  currentKw: number;
  hourBudgetKw: number;
  projectedOverHardCap: boolean;
}): HeadroomWidgetLimitState => {
  const { currentKw, hourBudgetKw, projectedOverHardCap } = params;
  // When the status doesn't carry the flag we cannot prove the trajectory, so
  // we never escalate to `over_cap` on its absence.
  if (projectedOverHardCap) return 'over_cap';
  if (hourBudgetKw <= 0) return 'under';
  const ratio = currentKw / hourBudgetKw;
  if (ratio >= 1) return 'at_pace';
  if (ratio >= NEAR_PACE_RATIO) return 'near';
  return 'under';
};

const emptyPayload = (subtitle: string): HeadroomWidgetEmptyPayload => ({
  state: 'empty',
  subtitle,
});

export const buildHeadroomWidgetPayload = (input: HeadroomWidgetInput): HeadroomWidgetPayload => {
  const status = input.status;
  if (!status) return emptyPayload(EMPTY_SUBTITLE_DEFAULT);

  const hourBudgetKw = isFiniteNumber(status.hourlyLimitKw) ? status.hourlyLimitKw : null;
  const headroomKw = isFiniteNumber(status.headroomKw) ? status.headroomKw : null;
  if (hourBudgetKw === null || headroomKw === null) return emptyPayload(EMPTY_SUBTITLE_DEFAULT);

  const currentKw = Math.max(0, hourBudgetKw - headroomKw);
  const shedCount = isFiniteNumber(status.devicesOff) ? Math.max(0, Math.round(status.devicesOff)) : 0;
  const priceLevel = resolvePriceLevel(status.priceLevel);
  const limitState = resolveLimitState({
    currentKw,
    hourBudgetKw,
    projectedOverHardCap: status.projectedOverHardCap === true,
  });

  const lastUpdate = isFiniteNumber(status.lastPowerUpdate) ? status.lastPowerUpdate : null;
  const nowMs = isFiniteNumber(input.nowMs) ? input.nowMs : Date.now();
  const timeStale = lastUpdate === null ? true : (nowMs - lastUpdate) > STALE_AFTER_MS;
  // Render the last known headroom (dimmed) when the planner reports
  // `powerKnown=false`, instead of blanking. Matches the "don't delete
  // useful state on a transient miss" pattern in lib/plan/planHistory.ts.
  const stale = timeStale || status.powerKnown === false;

  const ready: HeadroomWidgetReadyPayload = {
    state: 'ready',
    currentKw,
    hourBudgetKw,
    headroomKw,
    shedCount,
    priceLevel,
    limitState,
    stale,
  };
  return ready;
};
