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
    hardCapHeadroomKw?: number | null;
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
 * re-deriving kW thresholds. "Over hard cap" (genuine exceedance) is the only
 * red/danger state; sitting at the dynamic safe pace under the physical
 * ceiling is correct operation and reads as the calmer `at_pace` state.
 */
const resolveLimitState = (params: {
  currentKw: number;
  hourBudgetKw: number;
  hardCapHeadroomKw: number | null;
}): HeadroomWidgetLimitState => {
  const { currentKw, hourBudgetKw, hardCapHeadroomKw } = params;
  // Over the physical hard cap is the only genuine exceedance. When the status
  // doesn't carry a hard-cap headroom we cannot prove an exceedance, so we
  // never escalate to `over_cap` on its absence.
  if (hardCapHeadroomKw !== null && hardCapHeadroomKw < 0) return 'over_cap';
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
  const hardCapHeadroomKw = isFiniteNumber(status.hardCapHeadroomKw) ? status.hardCapHeadroomKw : null;
  const shedCount = isFiniteNumber(status.devicesOff) ? Math.max(0, Math.round(status.devicesOff)) : 0;
  const priceLevel = resolvePriceLevel(status.priceLevel);
  const limitState = resolveLimitState({ currentKw, hourBudgetKw, hardCapHeadroomKw });
  // Positive amount over the physical hard cap (0 when at/under it). Negative
  // hard-cap headroom is the exceedance magnitude; resolve it to a flat kW here
  // so the renderer reads one number, never the signed source value.
  const overageKw = hardCapHeadroomKw !== null && hardCapHeadroomKw < 0
    ? -hardCapHeadroomKw
    : 0;

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
    overageKw,
    shedCount,
    priceLevel,
    limitState,
    stale,
  };
  return ready;
};
