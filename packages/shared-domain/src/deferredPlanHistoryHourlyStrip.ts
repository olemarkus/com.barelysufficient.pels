// Producer for the smart-task history-detail per-hour bar strip (v2.7.3).
//
// Resolves the postmortem question "when did each hour run, and what did
// each hour cost?" into a flat per-bucket payload the view layer renders
// without branching on the entry shape. Per
// `feedback_layering_resolution_in_producer.md`, every conditional
// (planned-vs-delivered, cheapest-hour glow, fallback to planned kWh)
// lives here so the renderer is a pure mapper.
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryHourlyTone,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;

// One bar on the strip. The view layer reads these fields directly without
// inspecting the entry — every conditional (cheap-hour glow, planned-but-
// skipped outline, kWh fallback) is resolved here.
export type HourlyStripBucket = {
  // Hour-aligned start; the view renders this on the same time axis as the
  // trajectory chart above. The view does not re-derive bucket positions
  // from the entry — windowStartMs / windowEndMs already span them.
  atMs: number;
  // Bar height in kWh. `delivered` when the hour was actually charged in;
  // falls back to `planned` when the hour was scheduled but not delivered
  // (the dashed-outline case). `0` means "this hour was neither scheduled
  // nor charged"; the view still emits the bucket so the strip's 24-hour
  // shape is intact, but renders nothing for it.
  kwh: number;
  // Hour-resolved tone for the fill colour. `null` only on buckets the
  // entry never carried a contribution or plan for — the view treats those
  // as gap buckets.
  tone: DeferredObjectivePlanHistoryHourlyTone | null;
  // True when the hour was planned by the original or final schedule
  // (regardless of whether the runtime delivered against it).
  planned: boolean;
  // True when at least one `recordHourlyDelivery` contribution landed on
  // the bucket. Bucket gets the solid-fill treatment.
  delivered: boolean;
  // True when `planned && !delivered`. The view renders a dashed 1 px
  // outline to read as "schedule said yes, machinery did not".
  outlinePresent: boolean;
  // True only on the single cheapest hour the run actually charged in
  // (`tone === 'cheap'` AND `delivered` AND lowest `priceValue` among
  // delivered hours). The view paints the soft accent glow on this bucket.
  // The producer guarantees at most one bucket per payload carries this.
  cheapestDeliveredHighlight: boolean;
  // The hour's spot price at contribution time, in the user's display
  // currency. `null` when the bucket had no contribution. The view
  // surfaces it in the tooltip.
  priceValue: number | null;
};

// Resolved bar-strip payload. `mode === 'absent'` means the entry has no
// usable per-hour data; the view suppresses the strip entirely so legacy
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

const floorToHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;
const ceilToHour = (ms: number): number => Math.ceil(ms / HOUR_MS) * HOUR_MS;

const indexContributions = (
  contributions: readonly DeferredObjectivePlanHistoryHourlyContribution[],
): Map<number, DeferredObjectivePlanHistoryHourlyContribution> => {
  const byAtMs = new Map<number, DeferredObjectivePlanHistoryHourlyContribution>();
  for (const contribution of contributions) {
    byAtMs.set(floorToHour(contribution.atMs), contribution);
  }
  return byAtMs;
};

// Collect planned-hour metadata from the original + final snapshots so the
// strip can show "scheduled but not delivered" even when the planner
// revised the schedule mid-run. The final plan wins on `plannedKWh`
// because it represents the planner's last word for that hour.
const indexPlannedHours = (
  original: DeferredObjectivePlanHistoryRevisionSnapshot | null,
  final: DeferredObjectivePlanHistoryRevisionSnapshot | null,
): Map<number, number> => {
  const byAtMs = new Map<number, number>();
  original?.hours.forEach((hour) => byAtMs.set(floorToHour(hour.startsAtMs), hour.plannedKWh));
  final?.hours.forEach((hour) => byAtMs.set(floorToHour(hour.startsAtMs), hour.plannedKWh));
  return byAtMs;
};

// Resolve the single bucket eligible for the cheapest-delivered glow. The
// design synthesis spec calls for one bucket only — `tone === 'cheap'`,
// delivered, and the lowest `priceValue` among delivered hours.
const resolveCheapestDeliveredAtMs = (
  contributions: readonly DeferredObjectivePlanHistoryHourlyContribution[],
): number | null => {
  let bestAtMs: number | null = null;
  let bestPrice = Number.POSITIVE_INFINITY;
  for (const contribution of contributions) {
    if (contribution.tone !== 'cheap') continue;
    if (contribution.deliveredKWh <= 0) continue;
    if (contribution.priceValue < bestPrice) {
      bestPrice = contribution.priceValue;
      bestAtMs = floorToHour(contribution.atMs);
    }
  }
  return bestAtMs;
};

/**
 * Compose the bar-strip payload for the postmortem.
 *
 * Returns `{ mode: 'absent' }` when the entry has neither hourly
 * contributions nor planned hours — the view suppresses the strip. Returns
 * `{ mode: 'present', buckets }` with one bucket per hour in
 * `[startedAtMs, deadlineAtMs]` otherwise. Each bucket is fully resolved
 * here so the view renders straight from the flat fields.
 */
export const resolveHistoryDetailHourlyStrip = (
  entry: Pick<DeferredObjectivePlanHistoryEntry,
    'startedAtMs' | 'deadlineAtMs' | 'hourlyContributions' | 'originalPlan' | 'finalPlan'>,
): DeferredPlanHistoryHourlyStripData => {
  const contributions = entry.hourlyContributions ?? [];
  // Suppress the strip entirely for entries with no hourly delivery data,
  // even when `originalPlan` carries planned hours. Legacy v4 entries (from
  // before `hourlyContributions` shipped) have planned hours but no
  // contributions — rendering an all-outlined strip would falsely imply
  // "PELS scheduled and then skipped every hour". The postmortem question
  // ("when did each hour run, and what did each hour cost?") has no honest
  // answer without delivery data, so we render the trajectory chart alone
  // for those entries. Planned-only entries that *do* carry contributions
  // still surface the outlined buckets for genuinely-skipped hours.
  if (contributions.length === 0) {
    return { mode: 'absent' };
  }
  const plannedByAtMs = indexPlannedHours(entry.originalPlan, entry.finalPlan);
  const contributionsByAtMs = indexContributions(contributions);
  const cheapestAtMs = resolveCheapestDeliveredAtMs(contributions);
  const windowStartMs = floorToHour(entry.startedAtMs);
  const windowEndMs = Math.max(ceilToHour(entry.deadlineAtMs), windowStartMs + HOUR_MS);
  const buckets: HourlyStripBucket[] = [];
  for (let atMs = windowStartMs; atMs < windowEndMs; atMs += HOUR_MS) {
    const contribution = contributionsByAtMs.get(atMs) ?? null;
    const plannedKWh = plannedByAtMs.get(atMs) ?? null;
    // A contribution with a positive kWh counts as delivered; a zero-kWh
    // contribution (real-but-zero, e.g. free-hour metering at 0) still
    // means the feed ran for the bucket, but the strip's bar height stays
    // 0 and the dashed-outline contract treats it as "not delivered" so
    // the bucket reads as restraint rather than action.
    const delivered = contribution !== null && contribution.deliveredKWh > 0;
    const planned = plannedKWh !== null;
    const outlinePresent = planned && !delivered;
    const kwh = delivered
      ? contribution.deliveredKWh
      : (plannedKWh ?? 0);
    const tone: DeferredObjectivePlanHistoryHourlyTone | null = contribution?.tone ?? null;
    buckets.push({
      atMs,
      kwh,
      tone,
      planned,
      delivered,
      outlinePresent,
      cheapestDeliveredHighlight: cheapestAtMs === atMs,
      priceValue: contribution?.priceValue ?? null,
    });
  }
  return {
    mode: 'present',
    windowStartMs,
    windowEndMs,
    buckets,
  };
};
