import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import {
  formatPlanHistoryDeadlineLine,
  formatPlanHistoryMissedReason,
  formatPlanHistoryObservedCoverage,
  formatPlanHistoryOvershootLine,
  formatPlanHistoryProgressLine,
  formatPlanHistoryReachedAtLine,
  getPlanHistoryOutcomeCardTone,
  getPlanHistoryOutcomeLabel,
  getPlanHistoryOutcomeTone,
} from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { formatPlanHistoryListCostAndDelivered } from '../../../../shared-domain/src/deferredPlanHistoryReceipt.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { buildDeadlineHistoryHref } from '../deadlineUrls.ts';

type DeadlinePlanHistoryProps = {
  entries: ResolvedDeferredObjectivePlanHistoryEntry[];
  timeZone: string;
};

export const PlanHistoryCard = ({ entry, timeZone }: {
  entry: ResolvedDeferredObjectivePlanHistoryEntry;
  timeZone: string;
}) => {
  const tone = getPlanHistoryOutcomeTone(entry.outcome);
  // Whole-row tonal container (PR2 spec §7) — the outcome paints the card
  // surface via the canonical `.pels-surface-card[data-tone="…"]` API, not just
  // the corner chip. Resolved producer-side so the view never maps outcome →
  // tone (`feedback_layering_resolution_in_producer.md`).
  const cardTone = getPlanHistoryOutcomeCardTone(entry.outcome);
  const outcomeLabel = getPlanHistoryOutcomeLabel(entry.outcome);
  const deadlineLine = formatPlanHistoryDeadlineLine(entry, timeZone);
  const progressLine = formatPlanHistoryProgressLine(entry);
  const reachedAtLine = formatPlanHistoryReachedAtLine(entry, timeZone);
  const coverageLine = formatPlanHistoryObservedCoverage(entry);
  // Overshoot note: muted line on Succeeded entries whose final reading exceeded
  // the target by > 5 °C / > 10 %. Null on the other outcomes so the line is
  // suppressed cleanly — view never branches on `outcome` itself.
  const overshootLine = formatPlanHistoryOvershootLine(entry);
  // Missed-row reason note: muted single-sentence "why" for Missed entries so
  // the user sees the cause without tapping through to the detail hero. Rendered
  // with a "Why:" lead-in (matching the detail hero) so it reads distinctly from
  // the same-tone coverage line below it, and folded into the row aria-label so
  // screen readers announce the cause. Sourced from the shared
  // `formatPlanHistoryMissedReason` helper, which also feeds runtime log
  // breadcrumbs — `feedback_ui_text_shared_with_logs.md`. Producer returns null
  // on non-missed outcomes so the view never branches on `outcome` itself.
  const missedReasonLine = formatPlanHistoryMissedReason(entry);
  // Muted "Cost ≈ X kr · Y kWh delivered" meta line from the persisted
  // delivery/cost totals, at WHOLE-kroner precision — the list-specific producer
  // matches the ISO-week divider heading directly above (whole-kr roll-up) and
  // the detail surface's cost chip, so the same money never shows two precisions
  // on one screen. (The 2-decimal sibling stays reserved for the Missed hero's
  // sparse fallback.) Returns null when neither delivery nor cost was recorded
  // (legacy entries) — the line is then suppressed, never faking a 0 kr / 0 kWh
  // row. The producer scales + labels with the entry's RECORDED price display
  // (legacy entries fall back to the recording-era øre/kr default), so the row
  // survives a later price-scheme switch — no live unit/divisor is threaded in.
  const costLine = formatPlanHistoryListCostAndDelivered(entry);
  // Trim trailing/leading whitespace from user-entered Homey device names so
  // the displayed row isn't padded. Empty / whitespace-only names collapse the
  // device line — matches the pre-fix falsy guard on the raw value.
  const displayDeviceName = entry.deviceName ? formatDisplayDeviceName(entry.deviceName) : '';
  return (
    <a
      class="pels-surface-card plan-history-card plan-history-card--link"
      data-tone={cardTone}
      aria-label={
        missedReasonLine
          ? `Past smart task ${deadlineLine}. Why: ${missedReasonLine}`
          : `Past smart task ${deadlineLine}`
      }
      href={buildDeadlineHistoryHref(entry.deviceId, entry.id)}
      data-interactive
    >
      {/* Canonical M3 hover-elevation + press-ripple, matching the active-list
          card (DeadlinesList.tsx). Each row now carries an outcome tonal
          container (`data-tone`), so the old `--link:hover` background swap was
          dropped (it would flatten the tone); the elevation lift + ripple are
          the interactivity affordance that keeps the tone intact. Without the
          `md-elevation` element the `--md-elevation-level: 3` hover rule has
          nothing to render. */}
      <MdElevation aria-hidden="true" />
      <MdRipple aria-hidden="true" />
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
      {missedReasonLine && (
        <div class="plan-history-card__reason">
          <span class="plan-history-card__reason-label">Why:</span> {missedReasonLine}
        </div>
      )}
      {overshootLine && (
        <div class="plan-history-card__overshoot">{overshootLine}</div>
      )}
      {coverageLine && (
        <div class="plan-history-card__coverage">{coverageLine}</div>
      )}
      {costLine && (
        <div class="plan-history-card__cost">{costLine}</div>
      )}
    </a>
  );
};

export const DeadlinePlanHistory = ({
  entries,
  timeZone,
}: DeadlinePlanHistoryProps) => {
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
