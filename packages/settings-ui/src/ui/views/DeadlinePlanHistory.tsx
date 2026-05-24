import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatPlanHistoryDeadlineLine,
  formatPlanHistoryObservedCoverage,
  formatPlanHistoryOvershootLine,
  formatPlanHistoryProgressLine,
  formatPlanHistoryReachedAtLine,
  getPlanHistoryOutcomeLabel,
  getPlanHistoryOutcomeTone,
} from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { buildDeadlineHistoryHref } from '../deadlineUrls.ts';

type DeadlinePlanHistoryProps = {
  entries: DeferredObjectivePlanHistoryEntry[];
  timeZone: string;
};

export const PlanHistoryCard = ({ entry, timeZone }: {
  entry: DeferredObjectivePlanHistoryEntry;
  timeZone: string;
}) => {
  const tone = getPlanHistoryOutcomeTone(entry.outcome);
  const outcomeLabel = getPlanHistoryOutcomeLabel(entry.outcome);
  const deadlineLine = formatPlanHistoryDeadlineLine(entry, timeZone);
  const progressLine = formatPlanHistoryProgressLine(entry);
  const reachedAtLine = formatPlanHistoryReachedAtLine(entry, timeZone);
  const coverageLine = formatPlanHistoryObservedCoverage(entry);
  // Overshoot note: muted line on Succeeded entries whose final reading exceeded
  // the target by > 5 °C / > 10 %. Null on the other outcomes so the line is
  // suppressed cleanly — view never branches on `outcome` itself.
  const overshootLine = formatPlanHistoryOvershootLine(entry);
  // Trim trailing/leading whitespace from user-entered Homey device names so
  // the displayed row isn't padded. Empty / whitespace-only names collapse the
  // device line — matches the pre-fix falsy guard on the raw value.
  const displayDeviceName = entry.deviceName ? formatDisplayDeviceName(entry.deviceName) : '';
  return (
    <a
      class="pels-surface-card plan-history-card plan-history-card--link"
      aria-label={`Past smart task ${deadlineLine}`}
      href={buildDeadlineHistoryHref(entry.deviceId, entry.id)}
      data-interactive
    >
      <header class="plan-history-card__header">
        <span class="plan-history-card__deadline">{deadlineLine}</span>
        <span class={`plan-chip plan-chip--${tone}`}>{outcomeLabel}</span>
      </header>
      {displayDeviceName !== '' && <div class="plan-history-card__device">{displayDeviceName}</div>}
      {progressLine && (
        <div class="plan-history-card__progress">
          {progressLine}
          {reachedAtLine && <span class="plan-history-card__reached">  ·  {reachedAtLine}</span>}
        </div>
      )}
      {overshootLine && (
        <div class="plan-history-card__overshoot">{overshootLine}</div>
      )}
      {coverageLine && (
        <div class="plan-history-card__coverage">{coverageLine}</div>
      )}
    </a>
  );
};

export const DeadlinePlanHistory = ({ entries, timeZone }: DeadlinePlanHistoryProps) => {
  if (entries.length === 0) {
    return (
      <section class="pels-surface-card plan-history-empty" aria-label="Past plans">
        <p class="pels-card-supporting">No past plans yet for this device.</p>
      </section>
    );
  }
  return (
    <section class="plan-history-list" aria-label="Past plans">
      {entries.map((entry) => (
        <PlanHistoryCard
          key={entry.id}
          entry={entry}
          timeZone={timeZone}
        />
      ))}
    </section>
  );
};
