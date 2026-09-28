import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';
import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings';
import type { DeferredPlanHistoryChartMode } from './deferredPlanHistoryChartData';

// ─── History-detail chart labels (v2.7.2 PR 4 copy lift) ──────────────────────
//
// User-visible chart strings — card titles, the legacy fallback note, the
// chart-collapse toggle, and the chart aria-label — for the smart-task
// history-detail surface. Lifted out of `DeadlinePlanHistoryDetail.tsx` per
// `feedback_ui_text_shared_with_logs` so runtime log breadcrumbs and the
// view read identical strings.
//
// The Phase 1B receipt-first redesign retired the ECharts legend (the DOM
// legend row's labels live in `deferredPlanHistoryDetailInteraction.ts`) so
// the series-name fields and the floating-tooltip absence line were removed
// here — the trajectory chart no longer renders a floating tooltip at all
// (pinned readout is the one interaction grammar).

export type HistoryDetailChartLabels = {
  /**
   * Chart card title; varies by mode (trajectory vs legacy_kwh fallback) and,
   * on trajectory mode, by objective kind (question-shaped per the chart
   * comprehension spec).
   */
  cardTitle: string;
  /**
   * Subtext shown under the chart card title in legacy fallback mode, and in
   * trajectory mode when no measured series draws (sample-less entry with no
   * honest start→final segment) — the caption is the honest substitute for a
   * fabricated Measured line. `null` when a measured line renders.
   */
  fallbackNote: string | null;
  /** Label shown on the chart-collapse toggle button when the chart is collapsed. */
  expandToggleLabel: string;
  /** Label shown on the chart-collapse toggle button when the chart is expanded. */
  collapseToggleLabel: string;
  /**
   * Aria-label for the trajectory chart wrapper. `deviceName` falls back to
   * `'this smart task'` at the call site when no device name is recorded;
   * this helper trusts the caller to pre-resolve the trimmed display name
   * (consistent with the rest of shared-domain — no Date / locale helpers).
   */
  formatTrajectoryAriaLabel: (deviceName: string) => string;
};

// Kind-aware question titles so the card states the question it answers
// (chart-overhaul Phase 1B; replaces the prior "Progress history").
const TRAJECTORY_CARD_TITLE_HEAT = 'Did it heat up as planned?';
const TRAJECTORY_CARD_TITLE_COOL = 'Did it cool down as planned?';
const TRAJECTORY_CARD_TITLE_TEMPERATURE = 'Did it change temperature as planned?';
const TRAJECTORY_CARD_TITLE_CHARGE = 'Did it charge as planned?';
const TRAJECTORY_CARD_TITLE_ENERGY = 'Was the energy delivered as planned?';

const LEGACY_CARD_TITLE = 'Scheduled vs observed';
const LEGACY_FALLBACK_NOTE = 'Schedule only — observations not recorded for this run.';
const EXPAND_TOGGLE_LABEL = 'View details';
const COLLAPSE_TOGGLE_LABEL = 'Hide details';

// Resolves the mode-aware chart-card title + the matching fallback note.
// Trajectory mode asks a direction-aware temperature question or the
// kind-aware charging question. Legacy mode keeps the prior
// "Scheduled vs observed" copy so v3 entries land on the same wording they
// did before PR 4. Picking once at the helper keeps the view's branching
// shallow.
const trajectoryCardTitle = (
  kind: DeferredObjectiveSettingsKind,
  direction: ResolvedDeferredObjectivePlanHistoryEntry['progressDirection'],
): string => {
  if (kind === 'ev_soc') return TRAJECTORY_CARD_TITLE_CHARGE;
  if (kind === 'energy') return TRAJECTORY_CARD_TITLE_ENERGY;
  if (direction === 'decreasing') return TRAJECTORY_CARD_TITLE_COOL;
  if (direction === 'unknown') return TRAJECTORY_CARD_TITLE_TEMPERATURE;
  return TRAJECTORY_CARD_TITLE_HEAT;
};

export const historyDetailChartLabels = (
  mode: DeferredPlanHistoryChartMode,
  kind: DeferredObjectiveSettingsKind,
  progressDirection: ResolvedDeferredObjectivePlanHistoryEntry['progressDirection'],
  // True when the chart payload carries a drawable measured series
  // (`observed.length > 0` — the producer guarantees ≥ 2 points or none).
  // Trajectory mode without one surfaces the absent-observations caption so
  // a sample-less entry says so instead of implying the staircase was
  // measured.
  hasMeasuredSeries = true,
): HistoryDetailChartLabels => ({
  cardTitle: mode === 'trajectory' ? trajectoryCardTitle(kind, progressDirection) : LEGACY_CARD_TITLE,
  fallbackNote: mode === 'trajectory' && hasMeasuredSeries ? null : LEGACY_FALLBACK_NOTE,
  expandToggleLabel: EXPAND_TOGGLE_LABEL,
  collapseToggleLabel: COLLAPSE_TOGGLE_LABEL,
  formatTrajectoryAriaLabel: (deviceName) => `Progress trajectory for ${deviceName}`,
});
