// Producer for the smart-task live page's schedule timeline ("When will it
// run, and at what price?"): per-period bars + pinned-readout lines +
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
} from '../../../shared-domain/src/smartTaskCopy/liveDetailCopy.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import {
  PLANNING_PRICE_REASON_LINE,
  planningPriceDivergesFromImport,
} from '../../../shared-domain/src/price/planningPrice.ts';
import { formatDeadlineFull, formatHourLabel } from './deadlinePlanFormatters.ts';
import { withInlinePriceUnit } from './priceUnit.ts';
import {
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

export const buildTimeline = (
  input: ObjectivePayloadReady,
  schedule: DeadlinePlanSchedule,
): DeadlinePlanPayload['timeline'] => {
  const { ctx, hours: horizon, costDisplay, priceUnitLabel } = input;
  const { nowMs, deadlineAtMs } = ctx;
  const { labels, originalChargeByStartMs, currentChargeByStartMs } = schedule;
  const latestRevisionReason = ctx.activePlan.latest.reason;
  const ariaLabel = `Smart task schedule for ${formatDisplayDeviceName(ctx.device.name)}`;
  // Direct callers with no price periods keep the same empty view shape,
  // with exact marker timestamps and no scheduled-duration caption.
  if (horizon.length === 0) {
    return {
      ariaLabel,
      hours: [],
      nowIndex: 0,
      nowAxisX: nowMs,
      deadlineAxisX: deadlineAtMs,
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
    // Device energy is tracked hourly. A prorated quarter is an estimate, not
    // a measured observation, so only an exact tracked hour gets that label.
    const measuredKwh = hour.startsAtMs % 3_600_000 === 0
      && hour.endMs - hour.startsAtMs === 3_600_000
      && input.ctx.activePlan.startedAtMs <= hour.startsAtMs
      ? resolveActualPeriodKwh(input, hour) : null;
    const revisionLine = hourChanged ? (labels.revisionReasonTooltipLine[latestRevisionReason] ?? null) : null;
    return {
      startsAtMs: hour.startsAtMs,
      endsAtMs: hour.endMs,
      time: formatHourLabel(hour.startsAtMs),
      price: formatPrice(displayPrice),
      priceValue: displayPrice,
      planned,
      changed: hourChanged,
      readout: {
        primary: formatSmartTaskHourReadoutPrimary(
          index === nowIndex ? NOW_MARKER_WORD : `${formatHourLabel(hour.startsAtMs)}–${formatHourLabel(hour.endMs)}`,
          withInlinePriceUnit(formatPrice(displayPrice), priceUnitLabel),
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
  return {
    ariaLabel,
    hours,
    nowIndex,
    nowAxisX: nowMs,
    deadlineAxisX: deadlineAtMs,
    deadlineMarkLabel: `${DEADLINE_MARKER_WORD} ${formatDeadlineFull(deadlineAtMs)}`,
    // The caption sums scheduled duration and weights planning prices by
    // duration, using the same display periods as the bars. The hero's money
    // cost remains based on import prices, so the two can differ for a solar
    // home. Shared-domain owns the duration, average and wording.
    cheapestHoursCaption: formatCheapestHoursCaption(
      hours.filter((hour) => hour.planned),
      hours,
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

// Whole-home tracking remains hourly. Allocate each measured bucket's elapsed
// energy once across the displayed periods, including fractional-offset grids.
export const resolveActualPeriodKwh = (input: ObjectivePayloadReady, period: HorizonHour): number | null => {
  const hourMs = 60 * 60 * 1000;
  const fromMs = Math.max(period.startsAtMs, input.ctx.activePlan.startedAtMs);
  const toMs = Math.min(period.endMs, input.ctx.nowMs);
  let energy = 0;
  let observed = false;
  for (let atMs = Math.floor(fromMs / hourMs) * hourMs; atMs < toMs; atMs += hourMs) {
    const endMs = Math.min(atMs + hourMs, input.ctx.nowMs);
    const overlapMs = Math.max(0, Math.min(toMs, endMs) - Math.max(fromMs, atMs));
    const actual = resolveActualDeviceKwh(input.bootstrap, input.ctx.deviceId, atMs);
    if (actual === null || overlapMs <= 0) continue;
    observed = true;
    energy += actual * overlapMs / (endMs - atMs);
  }
  return observed ? energy : null;
};
