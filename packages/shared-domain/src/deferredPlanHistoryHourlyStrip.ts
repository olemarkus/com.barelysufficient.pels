import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryHourlyTone,
  DeferredObjectivePlanHistoryHourlyContribution,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { pickScheduledHours, type ScheduledHistoryHour } from './deferredPlanHistoryShared';

export type HourlyStripBucket = {
  // Recorded interval start; the view renders this on the same time axis as the
  // trajectory chart above. The view does not re-derive bucket positions
  // from the entry — windowStartMs / windowEndMs already span them.
  atMs: number;
  endsAtMs: number;
  // Bar height in kWh. Delivered energy takes precedence over planned
  // energy (the dashed-outline case). Zero buckets preserve time gaps.
  kwh: number;
  // Interval-resolved tone for the fill colour. `null` only on buckets the
  // entry never carried a contribution or plan for — the view treats those
  // as gap buckets.
  tone: DeferredObjectivePlanHistoryHourlyTone | 'mixed' | null;
  // True when the interval had work booked when it began (on entries recorded
  // before start bookings, when the original or final schedule planned
  // it), regardless of whether the runtime delivered against it.
  planned: boolean;
  // True when at least one delivery contribution landed on the bucket.
  // Bucket gets the solid-fill treatment.
  delivered: boolean;
  // True when `planned && !delivered`. The view renders a dashed 1 px
  // outline to read as "schedule said yes, machinery did not".
  outlinePresent: boolean;
  // True only on the single cheapest interval the run actually charged in
  // (`tone === 'cheap'` AND `delivered` AND lowest `priceValue` among
  // delivered intervals). The view paints the soft accent glow on this bucket.
  // The producer guarantees at most one bucket per payload carries this.
  cheapestDeliveredHighlight: boolean;
  // The interval's import price at contribution time, in the user's display
  // currency. `null` when the bucket had no contribution. The view
  // surfaces it in the tooltip.
  priceValue: number | null;
  priceIsAverage: boolean;
};

// Resolved bar-strip payload. `mode === 'absent'` means the entry has no
// usable contribution data; the view suppresses the strip entirely so legacy
// v4 entries (no `hourlyContributions`) keep rendering the trajectory
// chart only. `mode === 'present'` carries a non-empty bucket list.
export type DeferredPlanHistoryHourlyStripData =
  | { mode: 'absent' }
  | {
    mode: 'present';
    windowStartMs: number;
    windowEndMs: number;
    buckets: HourlyStripBucket[];
  };

type RecordedCostSpan = {
  atMs: number;
  endsAtMs: number;
  deliveredKWh: number;
  totalCost: number;
  priceValue: number;
  priceIsAverage: boolean;
  tone: DeferredObjectivePlanHistoryHourlyTone | 'mixed' | null;
};

// A restart may append quarter observations alongside an older hourly total.
// Keep overlapping observations at their coarsest recorded resolution: summing
// exact energy/cost is honest; reconstructing historical quarter prices is not.
const collectRecordedCostSpans = (
  contributions: readonly DeferredObjectivePlanHistoryHourlyContribution[],
  windowStartMs: number,
  windowEndMs: number,
): RecordedCostSpan[] => {
  const spans: RecordedCostSpan[] = [];
  for (const contribution of [...contributions].sort((a, b) => a.atMs - b.atMs)) {
    const atMs = Math.max(windowStartMs, contribution.atMs);
    const endsAtMs = Math.min(windowEndMs, contribution.endsAtMs);
    if (endsAtMs <= atMs) continue;
    const totalCost = contribution.priceValue * contribution.deliveredKWh;
    const previous = spans[spans.length - 1];
    if (previous && atMs < previous.endsAtMs) {
      const deliveredKWh = previous.deliveredKWh + contribution.deliveredKWh;
      const cost = previous.totalCost + totalCost;
      spans[spans.length - 1] = {
        atMs: previous.atMs, endsAtMs: Math.max(previous.endsAtMs, endsAtMs),
        deliveredKWh, totalCost: cost,
        priceValue: deliveredKWh > 0 ? cost / deliveredKWh : previous.priceValue,
        priceIsAverage: previous.priceIsAverage || previous.priceValue !== contribution.priceValue,
        tone: previous.tone === contribution.tone ? previous.tone : 'mixed',
      };
    } else {
      spans.push({ atMs, endsAtMs, deliveredKWh: contribution.deliveredKWh,
        totalCost, priceValue: contribution.priceValue, priceIsAverage: false, tone: contribution.tone });
    }
  }
  return spans;
};

// Before start bookings were recorded, the strip showed both snapshots so a
// period removed by a replan could still explain its missing delivery. Prefer
// the final allocation where they overlap without counting either plan twice.
const resolveStripBookings = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'hourStartBookings' | 'originalPlan' | 'finalPlan'>,
): readonly ScheduledHistoryHour[] => {
  if (entry.hourStartBookings !== undefined) return pickScheduledHours(entry) ?? [];
  const original = (entry.originalPlan?.hours ?? []).filter((period) => period.plannedKWh > 0);
  const final = (entry.finalPlan?.hours ?? []).filter((period) => period.plannedKWh > 0);
  const boundaries = [...new Set([...original, ...final]
    .flatMap((period) => [period.coversFromMs ?? period.startsAtMs, period.endsAtMs]))].sort((a, b) => a - b);
  return boundaries.slice(0, -1).flatMap((atMs, index) => {
    const coversStart = (period: ScheduledHistoryHour): boolean => (
      (period.coversFromMs ?? period.startsAtMs) <= atMs && atMs < period.endsAtMs
    );
    const period = final.find(coversStart) ?? original.find(coversStart);
    if (period === undefined) return [];
    const endsAtMs = boundaries[index + 1]!;
    const coveredStartMs = period.coversFromMs ?? period.startsAtMs;
    return [{
      startsAtMs: atMs,
      endsAtMs,
      plannedKWh: period.plannedKWh * (endsAtMs - atMs) / (period.endsAtMs - coveredStartMs),
    }];
  });
};

export const resolveHistoryDetailHourlyStrip = (
  entry: Pick<DeferredObjectivePlanHistoryEntry,
    'startedAtMs' | 'deadlineAtMs' | 'hourlyContributions' | 'hourStartBookings' | 'originalPlan' | 'finalPlan'>,
): DeferredPlanHistoryHourlyStripData => {
  const spans = collectRecordedCostSpans(entry.hourlyContributions ?? [], entry.startedAtMs, entry.deadlineAtMs);
  if (spans.length === 0) return { mode: 'absent' };
  const bookings = resolveStripBookings(entry);
  const bookingBoundaries = bookings.flatMap((period) => [period.coversFromMs ?? period.startsAtMs, period.endsAtMs])
    .filter((atMs) => atMs > entry.startedAtMs && atMs < entry.deadlineAtMs
      && !spans.some((span) => span.atMs < atMs && atMs < span.endsAtMs));
  const boundaries = [...new Set([
    entry.startedAtMs, entry.deadlineAtMs, ...bookingBoundaries,
    ...spans.flatMap((period) => [period.atMs, period.endsAtMs]),
  ])].sort((a, b) => a - b);
  const buckets: HourlyStripBucket[] = boundaries.slice(0, -1).map((atMs, index) => {
    const endsAtMs = boundaries[index + 1]!;
    const contribution = spans.find((period) => period.atMs === atMs && period.endsAtMs === endsAtMs);
    const deliveredKWh = contribution?.deliveredKWh ?? 0;
    const plannedKWh = bookings.reduce((sum, period) => {
      const startMs = period.coversFromMs ?? period.startsAtMs;
      const overlap = Math.max(0, Math.min(endsAtMs, period.endsAtMs) - Math.max(atMs, startMs));
      return sum + (overlap > 0 ? period.plannedKWh * overlap / (period.endsAtMs - startMs) : 0);
    }, 0);
    const delivered = deliveredKWh > 0;
    const planned = plannedKWh > 0;
    return {
      atMs, endsAtMs,
      kwh: delivered ? deliveredKWh : plannedKWh,
      tone: contribution?.tone ?? null,
      planned, delivered,
      outlinePresent: planned && !delivered,
      cheapestDeliveredHighlight: false,
      priceValue: contribution?.priceValue ?? null,
      priceIsAverage: contribution?.priceIsAverage ?? false,
    };
  });
  const cheapest = buckets.filter((bucket) => bucket.delivered && bucket.tone === 'cheap')
    .sort((a, b) => a.priceValue! - b.priceValue!)[0];
  return {
    mode: 'present', windowStartMs: entry.startedAtMs, windowEndMs: entry.deadlineAtMs,
    buckets: buckets.map((bucket) => ({ ...bucket, cheapestDeliveredHighlight: bucket === cheapest })),
  };
};
