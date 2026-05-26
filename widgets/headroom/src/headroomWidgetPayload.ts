import type {
  HeadroomWidgetEmptyPayload,
  HeadroomWidgetPayload,
  HeadroomWidgetPriceLevel,
  HeadroomWidgetReadyPayload,
} from './headroomWidgetTypes';

const STALE_AFTER_MS = 90 * 1000;
export const EMPTY_SUBTITLE_DEFAULT = 'No data yet';

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
    controlledKw?: number;
    uncontrolledKw?: number;
    devicesOff?: number;
    priceLevel?: unknown;
    lastPowerUpdate?: number | null;
    powerKnown?: boolean;
  } | null;
  nowMs?: number;
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
    stale,
  };
  return ready;
};
