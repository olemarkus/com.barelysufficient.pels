import { Chip } from './components/Chip.tsx';
import { chipToneForOutcome } from './components/chipTone.ts';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import {
  formatPlanHistoryDeadlineLine,
  formatPlanHistoryDeliveryReason,
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
  // Shared delivery evidence lets the archive explain a miss or confirmed
  // device idle without having to open the run.
  const reasonLine = formatPlanHistoryDeliveryReason(entry);
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
        reasonLine
          ? `Past smart task ${deadlineLine}. Why: ${reasonLine}`
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
        <Chip tone={chipToneForOutcome(tone)}>{outcomeLabel}</Chip>
      </header>
      {displayDeviceName !== '' && <div class="plan-history-card__device">{displayDeviceName}</div>}
      {progressLine && (
        <div class="plan-history-card__progress">
          {progressLine}
          {reachedAtLine && <span class="plan-history-card__reached">  ·  {reachedAtLine}</span>}
        </div>
      )}
      {reasonLine && (
        <div class="plan-history-card__reason">
          <span class="plan-history-card__reason-label">Why:</span> {reasonLine}
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
