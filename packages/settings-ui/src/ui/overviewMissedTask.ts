import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatEarlierMissBlocker, formatFinalMissBlocker,
} from '../../../shared-domain/src/deferredPlanHistoryAttribution.ts';
import { formatHistoryValueForKind } from '../../../shared-domain/src/deferredPlanHistoryShared.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { buildDeadlineHistoryHref } from './deadlineUrls.ts';
import { formatSmartTaskDeadlineLong } from '../../../shared-domain/src/smartTaskDeadlineFormat.ts';
import { getHomeyTimezone } from './homey.ts';
import type { OverviewDecisionItem } from './overviewDecision.ts';

export type OverviewMissedTask = {
  title: string;
  deviceName: string;
  deviceId: string;
  result: string | null;
  reason: string;
  href: string;
  expiresAtMs: number;
  checks: readonly OverviewDecisionItem[];
};

const resolveMissedTaskChecks = (
  entry: ResolvedDeferredObjectivePlanHistoryEntry,
  finalBlocker: string | null,
): OverviewDecisionItem[] => {
  if (entry.deliveryExplanation.kind === 'legacy_unrecorded') {
    return [{ label: 'Why the target was missed', state: 'not_recorded' }];
  }

  const primary = entry.deliveryExplanation.primary;
  const couldNotVerify = primary.kind === 'blocked'
    && (primary.cause === 'observation_unavailable' || primary.cause === 'progress_unavailable');
  const checks: OverviewDecisionItem[] = finalBlocker === null || couldNotVerify
    ? [{ label: 'Why the target was missed', state: 'unverified', detail: finalBlocker ?? undefined }]
    : [{ label: 'Target reached by the deadline', state: 'not_met', detail: finalBlocker }];
  const earlier = formatEarlierMissBlocker(entry);
  return earlier === null ? checks : [...checks, { label: 'Earlier delivery', state: 'held_back', detail: earlier }];
};

const RECENT_MISS_MS = 24 * 60 * 60 * 1000;

export const resolveOverviewMissedTask = (
  entries: readonly ResolvedDeferredObjectivePlanHistoryEntry[],
  nowMs: number,
): OverviewMissedTask | null => {
  // The archive is sorted by finalization, but a run can finalize after a
  // newer one if delivery data is recovered after a restart.
  const latestRun = new Map<string, ResolvedDeferredObjectivePlanHistoryEntry>();
  for (const candidate of entries) {
    const latest = latestRun.get(candidate.deviceId);
    if (!latest || candidate.startedAtMs > latest.startedAtMs) latestRun.set(candidate.deviceId, candidate);
  }
  const entry = entries.find((candidate) => (
    candidate.outcome === 'missed' && latestRun.get(candidate.deviceId) === candidate
    && candidate.deadlineAtMs <= nowMs && nowMs - candidate.deadlineAtMs < RECENT_MISS_MS
  ));
  if (!entry) return null;
  const deadline = formatSmartTaskDeadlineLong(entry.deadlineAtMs, nowMs, getHomeyTimezone())
    .replace(/^Today /, 'today ');
  const { finalProgressValue, targetValue, objectiveKind } = entry;
  const result = finalProgressValue === null || targetValue === null ? null : [
    `Last recorded ${formatHistoryValueForKind(objectiveKind, finalProgressValue)}`,
    `Target ${formatHistoryValueForKind(objectiveKind, targetValue)}`,
  ].join(' · ');
  const finalBlocker = formatFinalMissBlocker(entry);
  const reason = entry.deliveryExplanation.kind === 'legacy_unrecorded'
    ? 'PELS didn’t record why the target was missed.'
    : finalBlocker ?? 'PELS couldn’t confirm why the target was missed.';
  const deviceName = formatDisplayDeviceName(entry.deviceName);
  return {
    title: `${deviceName} missed its target for ${deadline}`,
    deviceName,
    deviceId: entry.deviceId,
    result,
    reason,
    expiresAtMs: entry.deadlineAtMs + RECENT_MISS_MS,
    checks: resolveMissedTaskChecks(entry, finalBlocker),
    href: buildDeadlineHistoryHref(entry.deviceId, entry.id),
  };
};
