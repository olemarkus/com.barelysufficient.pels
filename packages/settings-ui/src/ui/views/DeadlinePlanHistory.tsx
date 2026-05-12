import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatPlanHistoryDeadlineLine,
  formatPlanHistoryObservedCoverage,
  formatPlanHistoryProgressLine,
  formatPlanHistoryReachedAtLine,
  getPlanHistoryOutcomeLabel,
  getPlanHistoryOutcomeTone,
  shouldShowBackupHoursPill,
} from '../../../../shared-domain/src/deferredPlanHistory.ts';

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
  return (
    <article class="plan-history-card" aria-label={`Past plan ${deadlineLine}`}>
      <header class="plan-history-card__header">
        <span class="plan-history-card__deadline">{deadlineLine}</span>
        <span class={`plan-chip plan-chip--${tone}`}>{outcomeLabel}</span>
      </header>
      {entry.deviceName && <div class="plan-history-card__device">{entry.deviceName}</div>}
      {progressLine && (
        <div class="plan-history-card__progress">
          {progressLine}
          {reachedAtLine && <span class="plan-history-card__reached">  ·  {reachedAtLine}</span>}
        </div>
      )}
      {coverageLine && (
        <div class="plan-history-card__coverage">{coverageLine}</div>
      )}
      {shouldShowBackupHoursPill(entry) && (
        <div class="plan-history-card__pills">
          <span class="plan-chip plan-chip--info">Backup hours</span>
        </div>
      )}
    </article>
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
          key={`${entry.deviceId}-${entry.deadlineAtMs}-${entry.finalizedAtMs}`}
          entry={entry}
          timeZone={timeZone}
        />
      ))}
    </section>
  );
};
