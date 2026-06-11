// Producer for the smart-task live page's schedule timeline ("When will it
// run, and at what price?"): per-hour bars + pinned-readout lines + planned
// markArea ranges + now/deadline marker coordinates + the trust caption.
// Split out of `deadlinePlan.ts` (payload assembly) to keep that file under
// the max-lines ceiling; this module owns every timeline-side resolution so
// the view renders flat data only.
import type { SettingsUiBootstrap } from '../../../contracts/src/settingsUiApi.ts';
import type { ObservedDeviceState } from '../../../contracts/src/types.ts';
import type { DeferredObjectiveActivePlanRevisionReason } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import {
  DEADLINE_MARKER_WORD,
  formatCheapestHoursCaption,
  formatSmartTaskHourReadoutPrimary,
  NOW_MARKER_WORD,
  type DeadlineLabels,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { formatDeadlineFull, formatHourLabel } from './deadlinePlanFormatters.ts';
import { ONE_HOUR_MS, type HorizonHour } from './deadlinePlanData.ts';
import { collectPlannedRanges } from './deadlinePlanTrajectory.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import type { DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

const formatPrice = (total: number): string => total.toFixed(2);

export const resolveActualDeviceKwh = (params: {
  bootstrap: SettingsUiBootstrap;
  deviceId: string;
  startsAtMs: number;
}): number | null => {
  const bucketKey = new Date(params.startsAtMs).toISOString();
  const value = params.bootstrap.power.tracker?.deviceBuckets?.[params.deviceId]?.[bucketKey];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
};

const resolvePriceTone = (hour: HorizonHour): DeadlinePlanPayload['timeline']['hours'][number]['tone'] => {
  if (hour.isCheap === true) return 'cheap';
  if (hour.isExpensive === true) return 'expensive';
  return 'normal';
};

// Resolve the index of the hour column containing `nowMs`. The window can
// start before now (it opens at the plan's original revision time), so "Now"
// is not necessarily index 0. Falls back to the last hour that started before
// now (or 0) when a price gap leaves now unmatched.
const resolveNowIndex = (hours: HorizonHour[], nowMs: number): number => {
  const exact = hours.findIndex((hour) => nowMs >= hour.startsAtMs && nowMs < hour.endMs);
  if (exact >= 0) return exact;
  for (let i = hours.length - 1; i >= 0; i -= 1) {
    if (hours[i].startsAtMs <= nowMs) return i;
  }
  return 0;
};

// Fractional category-axis coordinate for a timestamp. With `boundaryGap:
// true` category `i` spans `[i - 0.5, i + 0.5]`, so an in-hour fraction maps
// the timestamp to its true x-position (the deadline markLine must sit at the
// real deadline, not the centre of the last bar).
const toCategoryAxisX = (hours: HorizonHour[], index: number, atMs: number): number => {
  const hour = hours[index];
  const fraction = Math.min(1, Math.max(0, (atMs - hour.startsAtMs) / ONE_HOUR_MS));
  return index - 0.5 + fraction;
};

export const buildTimeline = (params: {
  device: ObservedDeviceState;
  bootstrap: SettingsUiBootstrap;
  deviceId: string;
  hours: HorizonHour[];
  originalChargeByStartMs: Map<number, number>;
  currentChargeByStartMs: Map<number, number>;
  latestRevisionReason: DeferredObjectiveActivePlanRevisionReason | null;
  labels: DeadlineLabels;
  deadlineAtMs: number;
  nowMs: number;
  costDisplay: CostDisplay;
  priceUnitLabel: string;
}): DeadlinePlanPayload['timeline'] => {
  const ariaLabel = `Smart task schedule for ${formatDisplayDeviceName(params.device.name)}`;
  // Empty price window: `lastIndex` would be -1 and `toCategoryAxisX` would
  // index `hours[-1]` (TypeError). The normal path can't reach here —
  // `prepareObjectivePayload` routes zero-hour windows to `awaiting_prices` —
  // but direct callers get the same flat shape the view already tolerates for
  // an absent selection (`hours[effectiveIndex]` is optional-chained and the
  // chart builders handle empty arrays), with the markLines parked at the
  // first category edge and the caption suppressed.
  if (params.hours.length === 0) {
    return {
      ariaLabel,
      hours: [],
      nowIndex: 0,
      nowAxisX: -0.5,
      deadlineAxisX: -0.5,
      deadlineMarkLabel: `${DEADLINE_MARKER_WORD} ${formatDeadlineFull(params.deadlineAtMs)}`,
      plannedRanges: [],
      cheapestHoursCaption: null,
    };
  }
  const nowIndex = resolveNowIndex(params.hours, params.nowMs);
  // First planned hour after the current one — the idle "heating starts
  // 08:00" readout names it so the readout never claims the kind verb is
  // active while the hero says it starts later.
  const nextPlanned = params.hours.find((hour) => (
    hour.startsAtMs > params.nowMs && (params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0) > 0
  ));
  const nextStartLabel = nextPlanned ? formatHourLabel(nextPlanned.startsAtMs) : null;
  const hours = params.hours.map((hour, index) => {
    const originalKwh = params.originalChargeByStartMs.get(hour.startsAtMs) ?? 0;
    const currentKwh = params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
    const displayPrice = hour.price / Math.max(1, params.costDisplay.divisor);
    const hourChanged = Math.abs(originalKwh - currentKwh) > 0.001;
    const planned = currentKwh > 0;
    const measuredKwh = resolveActualDeviceKwh({
      bootstrap: params.bootstrap,
      deviceId: params.deviceId,
      startsAtMs: hour.startsAtMs,
    });
    const revisionLine = hourChanged && params.latestRevisionReason !== null
      ? (params.labels.revisionReasonTooltipLine[params.latestRevisionReason] ?? null)
      : null;
    return {
      startsAtMs: hour.startsAtMs,
      time: formatHourLabel(hour.startsAtMs),
      price: formatPrice(displayPrice),
      priceValue: displayPrice,
      tone: resolvePriceTone(hour),
      planned,
      changed: hourChanged,
      readout: {
        primary: formatSmartTaskHourReadoutPrimary({
          timeLabel: index === nowIndex ? NOW_MARKER_WORD : formatHourLabel(hour.startsAtMs),
          priceLabel: `${formatPrice(displayPrice)} ${params.priceUnitLabel}`,
          planned,
          plannedKwh: currentKwh,
          kindVerb: params.labels.deviceSeriesName,
          isNow: index === nowIndex,
          nextStartLabel,
          measuredKwh,
        }),
        secondary: revisionLine,
      },
    };
  });
  const lastIndex = params.hours.length - 1;
  return {
    ariaLabel,
    hours,
    nowIndex,
    nowAxisX: toCategoryAxisX(params.hours, nowIndex, params.nowMs),
    deadlineAxisX: toCategoryAxisX(params.hours, lastIndex, params.deadlineAtMs),
    deadlineMarkLabel: `${DEADLINE_MARKER_WORD} ${formatDeadlineFull(params.deadlineAtMs)}`,
    plannedRanges: collectPlannedRanges(
      hours.map((hour) => hour.planned),
      params.labels.deviceSeriesName,
    ),
    // Trust caption read from the same already-scaled per-hour display prices
    // (øre→kr handled upstream by the CostDisplay divisor) the chart renders.
    // Every hour in the window is eligible (the window ends at the deadline),
    // so "Picked N of the M hours it can use" reconciles with the bars
    // AND with the hero's planned-cost line — `resolveLiveCostAndDelivery`
    // sums Σ(price × planned kWh) over this same hour set. Averaging +
    // phrasing live in shared-domain so this stays a thin projection.
    cheapestHoursCaption: formatCheapestHoursCaption({
      plannedPrices: hours.filter((hour) => hour.planned).map((hour) => hour.priceValue),
      allPrices: hours.map((hour) => hour.priceValue),
      unitLabel: params.priceUnitLabel,
    }),
  };
};
