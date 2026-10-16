import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
  DeferredObjectivePlanPreviewUnavailableReason,
  SmartTaskQuickTarget,
  SmartTaskQuickTargetsRead,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { DeferredObjectiveSettingsKind } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { MeasuredPowerObservedProbe } from '../../../packages/contracts/src/types';
import {
  resolveDefaultSmartTaskKind,
  resolveSmartTaskQuickTargets,
  supportsSmartTaskKind,
  type SmartTaskDeviceLike,
} from '../../../packages/shared-domain/src/smartTaskDeviceKind';
import { buildSmartTaskCandidateBase } from './smartTaskCandidateRequest';

/**
 * Times each quick target against the planner. The earliest finish is not a
 * formula: it is the earliest half-hour deadline the preview pipeline (live
 * roster, power limits, budget, prices) calls `on_track`, found by binary search.
 * Feasibility only grows with the deadline, and a higher target never finishes
 * before a lower one, so each search starts where the previous target's ended.
 *
 * The search ends where the published prices do: a deadline past them previews
 * `missing_prices` (before the next day's prices are out, that is tonight), and
 * that says nothing about whether an earlier deadline is feasible.
 *
 * The deadline offered is that earliest finish plus slack, rounded up to the
 * half hour and kept within the priced window: a deadline at the earliest
 * finish leaves PELS no cheaper hour to choose and turns any delay into a miss.
 */

const SLOT_MS = 30 * 60 * 1000;
const SEARCH_SLOTS = 48;
const SLACK_FRACTION = 0.3;

export type SmartTaskQuickTargetPreview = (
  candidate: DeferredObjectivePlanPreviewCandidate,
) => DeferredObjectivePlanPreviewEstimate;

type SlotProbe = (target: number, slot: number) => DeferredObjectivePlanPreviewEstimate;

const ceilToSlot = (ms: number): number => Math.ceil(ms / SLOT_MS) * SLOT_MS;

const isOnTrack = (estimate: DeferredObjectivePlanPreviewEstimate): boolean => estimate.status === 'on_track';

// Reached since the targets were picked: nothing left to plan for this one.
const isMet = (estimate: DeferredObjectivePlanPreviewEstimate): boolean => estimate.status === 'satisfied';

const isPastPrices = (estimate: DeferredObjectivePlanPreviewEstimate): boolean => (
  estimate.status === 'unavailable' && estimate.unavailableReason === 'missing_prices'
);

// The first slot in `[low, high]` the predicate holds for, given it holds at
// `high` and, once true, stays true.
const firstSlotWhere = (low: number, high: number, holds: (slot: number) => boolean): number => {
  let from = low;
  let to = high;
  while (from < to) {
    const mid = Math.floor((from + to) / 2);
    if (holds(mid)) to = mid;
    else from = mid + 1;
  }
  return to;
};

type PricedWindow = { kind: 'priced'; lastSlot: number } | {
  kind: 'unavailable'; reason: DeferredObjectivePlanPreviewUnavailableReason;
};

// The last slot the published prices cover, probed with the lowest target.
const resolvePricedWindow = (
  probe: (slot: number) => DeferredObjectivePlanPreviewEstimate,
  firstSlot: number,
): PricedWindow => {
  const unavailable = (estimate: DeferredObjectivePlanPreviewEstimate): PricedWindow => (
    { kind: 'unavailable', reason: estimate.unavailableReason ?? 'unknown' }
  );
  const farthest = probe(SEARCH_SLOTS);
  if (farthest.status !== 'unavailable') return { kind: 'priced', lastSlot: SEARCH_SLOTS };
  if (!isPastPrices(farthest)) return unavailable(farthest);
  const nearest = probe(firstSlot);
  if (isPastPrices(nearest) || nearest.status === 'unavailable') return unavailable(nearest);
  // The first slot past the prices, minus one.
  return { kind: 'priced', lastSlot: firstSlotWhere(firstSlot, SEARCH_SLOTS, (slot) => isPastPrices(probe(slot))) - 1 };
};

const memoizedProbe = (
  kind: DeferredObjectiveSettingsKind,
  preview: SmartTaskQuickTargetPreview,
  slotDeadline: (slot: number) => number,
): SlotProbe => {
  const seen = new Map<string, DeferredObjectivePlanPreviewEstimate>();
  return (target, slot) => {
    const key = `${target}@${slot}`;
    const known = seen.get(key);
    if (known) return known;
    const estimate = preview(buildSmartTaskCandidateBase(kind, target, slotDeadline(slot)));
    seen.set(key, estimate);
    return estimate;
  };
};

/** `targets` ascending, as `resolveSmartTaskQuickTargets` returns them. */
export const estimateSmartTaskQuickTargets = (
  kind: DeferredObjectiveSettingsKind,
  targets: readonly number[],
  preview: SmartTaskQuickTargetPreview,
  nowMs: number,
): SmartTaskQuickTargetsRead => {
  const slotZeroMs = ceilToSlot(nowMs);
  const slotDeadline = (slot: number): number => slotZeroMs + slot * SLOT_MS;
  // The next half hour, unless that is now.
  const firstSlot = slotZeroMs > nowMs ? 0 : 1;
  const probe = memoizedProbe(kind, preview, slotDeadline);
  const [lowestTarget] = targets;
  if (lowestTarget === undefined) return { state: 'ready', targets: [] };
  const window = resolvePricedWindow((slot) => probe(lowestTarget, slot), firstSlot);
  if (window.kind === 'unavailable') return { state: 'unavailable', reason: window.reason };
  const quickTargets: SmartTaskQuickTarget[] = [];
  let fromSlot = firstSlot;
  for (const target of targets) {
    const atLastSlot = probe(target, window.lastSlot);
    if (isMet(atLastSlot)) continue;
    // A higher target cannot finish sooner, so none after this one can either.
    if (!isOnTrack(atLastSlot)) break;
    const earliestSlot = firstSlotWhere(fromSlot, window.lastSlot, (slot) => isOnTrack(probe(target, slot)));
    fromSlot = earliestSlot;
    const earliestMs = slotDeadline(earliestSlot);
    const paddedMs = ceilToSlot(earliestMs + (earliestMs - nowMs) * SLACK_FRACTION);
    const deadlineAtMs = Math.min(paddedMs, slotDeadline(window.lastSlot));
    const estimate = probe(target, Math.round((deadlineAtMs - slotZeroMs) / SLOT_MS));
    if (!isOnTrack(estimate)) break;
    // eslint-disable-next-line functional/immutable-data -- In-place accumulation of a local result list.
    quickTargets.push({ target, deadlineAtMs, estimate });
  }
  return { state: 'ready', targets: quickTargets };
};

/**
 * The quick targets for a new task on `device`, of the kind a creation surface
 * defaults to. A device that takes no task, or a kind with no quick targets,
 * offers none.
 */
export const previewSmartTaskQuickTargetsForDevice = (
  device: SmartTaskDeviceLike & MeasuredPowerObservedProbe,
  preview: SmartTaskQuickTargetPreview,
  nowMs: number,
): SmartTaskQuickTargetsRead => {
  const kind = resolveDefaultSmartTaskKind(device);
  if (kind === null || !supportsSmartTaskKind(device, kind)) return { state: 'ready', targets: [] };
  return estimateSmartTaskQuickTargets(kind, resolveSmartTaskQuickTargets(device, kind), preview, nowMs);
};
