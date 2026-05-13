import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatPlanHistoryDeadlineLine,
  formatPlanHistoryObservedCoverage,
  formatPlanHistoryProgressLine,
  formatPlanHistoryReachedAtLine,
  getPlanHistoryOutcomeLabel,
  getPlanHistoryOutcomeTone,
} from '../../../../shared-domain/src/deferredPlanHistory.ts';

type Props = {
  entry: DeferredObjectivePlanHistoryEntry;
  timeZone: string;
};

const formatHour = (startsAtMs: number, timeZone: string): string => (
  new Date(startsAtMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
);

const formatRevisedAt = (revisedAtMs: number, timeZone: string): string => (
  new Date(revisedAtMs).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
);

const revisionsDiffer = (
  a: DeferredObjectivePlanHistoryRevisionSnapshot,
  b: DeferredObjectivePlanHistoryRevisionSnapshot,
): boolean => {
  if (a.hours.length !== b.hours.length) return true;
  for (let i = 0; i < a.hours.length; i += 1) {
    const left = a.hours[i]!;
    const right = b.hours[i]!;
    if (left.startsAtMs !== right.startsAtMs) return true;
    if (Math.abs(left.plannedKWh - right.plannedKWh) > 0.001) return true;
  }
  return Math.abs(a.energyNeededKWh - b.energyNeededKWh) > 0.001
    || a.planStatus !== b.planStatus;
};

const PlanRevisionTable = ({
  title,
  revision,
  timeZone,
}: {
  title: string;
  revision: DeferredObjectivePlanHistoryRevisionSnapshot;
  timeZone: string;
}) => {
  const charging = revision.hours.filter((hour) => hour.plannedKWh > 0);
  return (
    <section class="plan-history-detail__revision pels-surface-card">
      <header class="plan-history-detail__revision-header">
        <h2 class="plan-card__title">{title}</h2>
        <span class="pels-card-supporting">
          Revised {formatRevisedAt(revision.revisedAtMs, timeZone)} · Needed {revision.energyNeededKWh.toFixed(1)} kWh
        </span>
      </header>
      {charging.length === 0 ? (
        <p class="pels-card-supporting">No charging hours planned.</p>
      ) : (
        <ul class="plan-history-detail__hours" aria-label={`${title} charging hours`}>
          {charging.map((hour) => (
            <li class="plan-history-detail__hour" key={hour.startsAtMs}>
              <span class="plan-history-detail__hour-time">{formatHour(hour.startsAtMs, timeZone)}</span>
              <span class="plan-history-detail__hour-kwh">{hour.plannedKWh.toFixed(2)} kWh</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export const DeadlinePlanHistoryDetail = ({ entry, timeZone }: Props) => {
  const tone = getPlanHistoryOutcomeTone(entry.outcome);
  const outcomeLabel = getPlanHistoryOutcomeLabel(entry.outcome);
  const deadlineLine = formatPlanHistoryDeadlineLine(entry, timeZone);
  const progressLine = formatPlanHistoryProgressLine(entry);
  const reachedAtLine = formatPlanHistoryReachedAtLine(entry, timeZone);
  const coverageLine = formatPlanHistoryObservedCoverage(entry);
  const showFinalSeparately = entry.originalPlan && entry.finalPlan
    && revisionsDiffer(entry.originalPlan, entry.finalPlan);
  return (
    <article class="plan-history-detail" aria-label={`Past plan ${deadlineLine}`}>
      <section class="pels-surface-card plan-history-detail__hero">
        <header class="plan-history-detail__hero-header">
          <h1 class="plan-card__title">{deadlineLine}</h1>
          <span class={`plan-chip plan-chip--${tone}`}>{outcomeLabel}</span>
        </header>
        {entry.deviceName && (
          <p class="plan-history-detail__device">{entry.deviceName}</p>
        )}
        {progressLine && (
          <p class="plan-history-detail__progress">
            {progressLine}
            {reachedAtLine && <span class="plan-history-detail__reached">  ·  {reachedAtLine}</span>}
          </p>
        )}
        {coverageLine && <p class="pels-card-supporting">{coverageLine}</p>}
      </section>
      {entry.originalPlan ? (
        <PlanRevisionTable
          title={showFinalSeparately ? 'Original plan' : 'Plan'}
          revision={entry.originalPlan}
          timeZone={timeZone}
        />
      ) : (
        <section class="pels-surface-card">
          <p class="pels-card-supporting">
            No plan detail was recorded for this run. It may have finalized before the planner produced a revision, or it predates plan-snapshot tracking.
          </p>
        </section>
      )}
      {showFinalSeparately && entry.finalPlan && (
        <PlanRevisionTable
          title="Final plan"
          revision={entry.finalPlan}
          timeZone={timeZone}
        />
      )}
    </article>
  );
};
