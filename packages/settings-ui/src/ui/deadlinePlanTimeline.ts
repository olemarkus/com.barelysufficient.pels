// Producer for the smart-task live page's schedule timeline ("When will it
// run, and at what price?"): per-hour bars + pinned-readout lines +
// now/deadline marker coordinates + the trust caption.
// Split out of `deadlinePlan.ts` (payload assembly) to keep that file under
// the max-lines ceiling; this module owns every timeline-side resolution so
// the view renders flat data only.
import type { SettingsUiBootstrap } from '../../../contracts/src/settingsUiApi.ts';
import {
  DEADLINE_MARKER_WORD,
  formatCheapestHoursCaption,
  formatSmartTaskHourReadoutPrimary,
  NOW_MARKER_WORD,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import {
  PLANNING_PRICE_REASON_LINE,
  planningPriceDivergesFromImport,
} from '../../../shared-domain/src/price/planningPrice.ts';
import { formatDeadlineFull, formatHourLabel } from './deadlinePlanFormatters.ts';
import {
  ONE_HOUR_MS,
  type DeadlinePlanSchedule,
  type HorizonHour,
  type ObjectivePayloadReady,
} from './deadlinePlanData.ts';
import type { DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

const formatPrice = (total: number): string => total.toFixed(2);

export const resolveActualDeviceKwh = (
  bootstrap: SettingsUiBootstrap,
  deviceId: string,
  startsAtMs: number,
): number | null => {
  const bucketKey = new Date(startsAtMs).toISOString();
  const value = bootstrap.power.tracker?.deviceBuckets?.[deviceId]?.[bucketKey];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
};

// Resolve the index of the hour column containing `nowMs`. The window can
// start before now (it opens at the plan's original revision time), so "Now"
// is not necessarily index 0. Falls back to the last hour that started before
// now (or 0) when a price gap leaves now unmatched.
const resolveNowIndex = (hours: HorizonHour[], nowMs: number): number => {
  const exact = hours.findIndex((hour) => nowMs >= hour.startsAtMs && nowMs < hour.endMs);
  if (exact >= 0) return exact;
  for (let i = hours.length - 1; i >= 0; i -= 1) {
    const hour = hours[i];
    if (hour !== undefined && hour.startsAtMs <= nowMs) return i;
  }
  return 0;
};

// Fractional category-axis coordinate for a timestamp. With `boundaryGap:
// true` category `i` spans `[i - 0.5, i + 0.5]`, so an in-hour fraction maps
// the timestamp to its true x-position (the deadline markLine must sit at the
// real deadline, not the centre of the last bar).
const toCategoryAxisX = (hours: HorizonHour[], index: number, atMs: number): number => {
  const hour = hours[index];
  // No hour at that slot: park at the category's left edge, where the
  // empty-window branch below already puts its markLines.
  if (hour === undefined) return index - 0.5;
  const fraction = Math.min(1, Math.max(0, (atMs - hour.startsAtMs) / ONE_HOUR_MS));
  return index - 0.5 + fraction;
};

export const buildTimeline = (
  input: ObjectivePayloadReady,
  schedule: DeadlinePlanSchedule,
): DeadlinePlanPayload['timeline'] => {
  const { ctx, hours: horizon, costDisplay, priceUnitLabel } = input;
  const { nowMs, deadlineAtMs } = ctx;
  const { labels, originalChargeByStartMs, currentChargeByStartMs } = schedule;
  const latestRevisionReason = ctx.activePlan.latest.reason;
  const ariaLabel = `Smart task schedule for ${formatDisplayDeviceName(ctx.device.name)}`;
  // Empty price window: `lastIndex` would be -1 and `toCategoryAxisX` would
  // index `hours[-1]` (TypeError). The normal path can't reach here —
  // `prepareObjectivePayload` routes zero-hour windows to `awaiting_prices` —
  // but direct callers get the same flat shape the view already tolerates for
  // an absent selection (`hours[effectiveIndex]` is optional-chained and the
  // chart builders handle empty arrays), with the markLines parked at the
  // first category edge and the caption suppressed.
  if (horizon.length === 0) {
    return {
      ariaLabel,
      hours: [],
      nowIndex: 0,
      nowAxisX: -0.5,
      deadlineAxisX: -0.5,
      deadlineMarkLabel: `${DEADLINE_MARKER_WORD} ${formatDeadlineFull(deadlineAtMs)}`,
      cheapestHoursCaption: null,
      planningPriceNote: null,
    };
  }
  const nowIndex = resolveNowIndex(horizon, nowMs);
  // First planned hour after the current one — the idle "heating starts
  // 08:00" readout names it so the readout never claims the kind verb is
  // active while the hero says it starts later.
  const nextPlanned = horizon.find((hour) => (
    hour.startsAtMs > nowMs && (currentChargeByStartMs.get(hour.startsAtMs) ?? 0) > 0
  ));
  const nextStartLabel = nextPlanned ? formatHourLabel(nextPlanned.startsAtMs) : null;
  const hours = horizon.map((hour, index) => {
    const originalKwh = originalChargeByStartMs.get(hour.startsAtMs) ?? 0;
    const currentKwh = currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
    // The schedule "at what price" is a PLANNING surface — show the planning
    // price (`budgetPrice ?? total`) the scheduler ranked hours on, not the
    // import money price. Equals the import price for a non-prosumer, so this
    // is byte-identical outside a solar home. The hero's cost lines stay on the
    // import price (`hour.price`) via `resolveLiveCostAndDelivery`.
    const displayPrice = hour.planningPrice / Math.max(1, costDisplay.divisor);
    const hourChanged = Math.abs(originalKwh - currentKwh) > 0.001;
    const planned = currentKwh > 0;
    const measuredKwh = resolveActualDeviceKwh(input.bootstrap, ctx.deviceId, hour.startsAtMs);
    const revisionLine = hourChanged ? (labels.revisionReasonTooltipLine[latestRevisionReason] ?? null) : null;
    return {
      startsAtMs: hour.startsAtMs,
      time: formatHourLabel(hour.startsAtMs),
      price: formatPrice(displayPrice),
      priceValue: displayPrice,
      planned,
      changed: hourChanged,
      readout: {
        primary: formatSmartTaskHourReadoutPrimary(
          index === nowIndex ? NOW_MARKER_WORD : formatHourLabel(hour.startsAtMs),
          `${formatPrice(displayPrice)} ${priceUnitLabel}`,
          currentKwh,
          labels.deviceSeriesName,
          index === nowIndex,
          nextStartLabel,
          measuredKwh,
        ),
        secondary: revisionLine,
      },
    };
  });
  const lastIndex = horizon.length - 1;
  return {
    ariaLabel,
    hours,
    nowIndex,
    nowAxisX: toCategoryAxisX(horizon, nowIndex, nowMs),
    deadlineAxisX: toCategoryAxisX(horizon, lastIndex, deadlineAtMs),
    deadlineMarkLabel: `${DEADLINE_MARKER_WORD} ${formatDeadlineFull(deadlineAtMs)}`,
    // Trust caption read from the same already-scaled per-hour display prices
    // (the PLANNING price, øre→kr handled upstream by the CostDisplay divisor)
    // the chart renders. Every hour in the window is eligible (the window ends
    // at the deadline), so "Picked N of the M hours it can use · avg P"
    // reconciles with the bars the user sees. It does NOT reuse the hero's
    // planned-cost figure — that stays on the import price
    // (`resolveLiveCostAndDelivery`), so for a prosumer the caption's planning
    // average and the hero's money cost legitimately differ. Averaging +
    // phrasing live in shared-domain so this stays a thin projection.
    cheapestHoursCaption: formatCheapestHoursCaption(
      hours.filter((hour) => hour.planned).map((hour) => hour.priceValue),
      hours.map((hour) => hour.priceValue),
      priceUnitLabel,
    ),
    // Bridge the planning-vs-import gap: the schedule readout shows the planning
    // price while the hero's cost line stays on the import price, so when any
    // hour's planning price VISIBLY diverges (gated on the display divisor) the
    // `using your solar` reason line explains why the two figures differ. Null
    // for a non-prosumer, where every hour's planning price equals its import
    // price (byte-identical).
    planningPriceNote: horizon.some(
      (hour) => planningPriceDivergesFromImport(hour.planningPrice, hour.price, costDisplay.divisor),
    ) ? PLANNING_PRICE_REASON_LINE : null,
  };
};
