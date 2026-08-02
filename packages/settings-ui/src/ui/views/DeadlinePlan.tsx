import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type {
  ActivePlanRevisionLogRow,
  ActivePlanRevisionLogSummary,
} from '../../../../shared-domain/src/activePlanRevisionLog.ts';
import {
  CREATE_SMART_TASK_WIDGET_COPY,
  deadlineLabels,
  formatLastSampleValue,
  formatSmartTaskGoalRangeHint,
  REVISION_PANEL_TITLE,
  SMART_TASK_EDIT_COPY,
  REVISION_REASON_FALLBACK_WITH_DETAIL,
  SMART_TASK_BANNER_RECORD_NOT_FOUND_BODY,
  SMART_TASK_BANNER_RECORD_NOT_FOUND_TITLE,
  SMART_TASK_BANNER_UNAVAILABLE_TITLE,
  NOW_MARKER_WORD,
  formatGrantedRescuePermissionsLine,
  SMART_TASK_EXTRA_PERMISSION_HINTS,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
  SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL,
  SMART_TASK_EXTRA_PERMISSIONS_TITLE,
  SMART_TASK_LIMIT_NEEDS_BUDGET_HINT,
  SMART_TASK_LOADING_LABEL,
  SMART_TASK_READOUT_SCRUB_HINT,
  SMART_TASK_SCHEDULE_CARD_TITLE,
  SMART_TASK_SCHEDULE_CHART_KEY,
  type DeadlineCannotMeetRecourse,
  type DeadlineLabels,
  type DeadlinePlanUnavailableReason,
  type KwhPerUnitProvenanceRow,
  type SmartTaskTrajectoryStateline,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { useEchartsMount, type EChartsOption, type EChartsType, type SeriesOption } from '../echartsRegistry.ts';
import { attachHourScrub, resolveScrubHourIndex } from '../deadlineChartScrub.ts';
import { resolveCategoryIndexFromPixel } from '../chartReadout.ts';
import { formatAcceptedAt, formatHourLabel } from '../deadlinePlanFormatters.ts';
import type { DeadlinePlanHistoryView } from '../deadlinePlanHistoryFetch.ts';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { DeadlinePlanHistoryDetail } from './DeadlinePlanHistoryDetail.tsx';
import { DeadlinesHistoryListRoot } from './DeadlinesHistoryList.tsx';
import { MdFilledButton, MdFilledTextField, MdSwitch, MdTextButton } from './materialWebJSX.tsx';
import type { SmartTaskEditPermissionKey, SmartTaskEditSnapshot } from '../smartTaskEdit.ts';
import { CheckCircleIcon, ExpandMoreIcon } from './icons.tsx';
import { logSettingsWarn } from '../logging.ts';

// Matches the `.plan-chip--*` CSS variants in
// `packages/settings-ui/public/style.css` (~1340-1374). `alert` was previously
// styled but unreferenced; surfacing it lets the cannot-finish chip use the
// same critical (red) tone as the hero rim instead of a warning (amber) tone
// that contradicted it.
type DeadlinePlanChipTone = 'alert' | 'info' | 'muted' | 'ok' | 'warn';

// Maps to the CSS `[data-tone="…"]` rim/background variants on `.pels-hero` /
// `.plan-hero` (style.css ~1287-1325). `good` is the on-track / satisfied
// state, `warn` covers at-risk, `alert` covers cannot-meet, `info` is the
// neutral pending hero. Keep this union in sync with the CSS bindings — a
// rim that never paints is worse than no rim at all.
export type DeadlinePlanHeroTone = 'good' | 'warn' | 'alert' | 'info';

type DeadlinePlanChip = {
  text: string;
  tone: DeadlinePlanChipTone;
  // True only for the "Building plan…" pending-state chip so the CSS
  // `.plan-chip[data-pulse="true"]` rule lights up a low-key opacity pulse.
  // Resolved producer-side from the pending liveState so the view never
  // branches on chip text or liveState — it just forwards the flat boolean
  // onto the DOM `data-pulse` attribute. Optional / undefined for every
  // other chip (kind, status, confidence, paused) so the attribute is
  // suppressed and those chips stay still. See
  // `packages/settings-ui/public/style.css` `.plan-chip[data-pulse="true"]`
  // for the keyframes + reduced-motion fallback.
  pulse?: boolean;
};

type DeadlinePlanHour = {
  // Hour-start timestamp. The trajectory chart's scrub handler maps time-axis
  // pixel positions back onto this hour grid, and the selection hairline sits
  // at `startsAtMs + 30 min`.
  startsAtMs: number;
  time: string;
  price: string;
  priceValue: number;
  planned: boolean;
  changed: boolean;
  // Pinned-readout lines for this hour, fully resolved at the producer
  // (`formatSmartTaskHourReadoutPrimary` + the revision-reason sentence).
  // `secondary` is null when the hour carries no revision narrative; the
  // view falls back to the scrub hint so the row keeps a stable two-line
  // height. At the default (no explicit selection) state the view shows the
  // scrub hint unconditionally — see `ScheduleQuestionCards`.
  readout: {
    primary: string;
    secondary: string | null;
  };
};

// Trajectory card payload ("Will it reach 65 °C in time?"). Every series,
// band, axis bound, and sentence arrives producer-resolved; the view only
// maps them onto ECharts series. Point tuples are `[ms, value]`.
export type DeadlineTrajectoryPayload = {
  cardTitle: string;
  ariaLabel: string;
  measuredPoints: Array<[number, number]>;
  nowPoint: [number, number];
  plannedPoints: Array<[number, number]>;
  runBands: Array<{ fromMs: number; toMs: number; label: string | null }>;
  targetValue: number;
  // "Target 65.0 °C" — anchored top-left at the line start (markPoint), NOT
  // an end label: end labels collide when the staircase converges on the
  // target line near the deadline.
  targetLabel: string;
  deadlineAtMs: number;
  deadlineMarkLabel: string;
  deadlineDanger: boolean;
  xMinMs: number;
  xMaxMs: number;
  yMin: number;
  yMax: number;
  yFloorLabel: string;
  stateline: SmartTaskTrajectoryStateline;
  // Vertical "7 °C short" gap annotation at the deadline; null when the
  // projected staircase reaches the target in time.
  shortfall: { fromValue: number; toValue: number; label: string } | null;
};

// A hero stat pair: a muted label above/beside a bold value (e.g.
// `Needs` / `12.0 kWh`). Rendered as a compact row so the numbers that
// matter are the loud element, not buried in a grey sentence wall.
export type DeadlineHeroStat = { label: string; value: string };

export type DeadlinePlanPayload = {
  kind: DeferredObjectiveSettingsKind;
  labels: DeadlineLabels;
  // Axis/tooltip label for hourly prices. Prices are already scaled to this
  // unit (e.g. divided by 100 to convert øre → kr/kWh) by the producer so the
  // chart renders raw display values; the Budget chart uses the same
  // CostDisplay so both surfaces show identical numbers.
  priceUnitLabel: string;
  hero: {
    chips: DeadlinePlanChip[];
    // Resolved at the producer (`deadlinePlan.ts`) from the active plan's
    // `planStatus` so the view never branches on planner internals. Keeps
    // chip text, rim colour, and meta line agreeing on a single "are we ok?"
    // signal.
    tone: DeadlinePlanHeroTone;
    // No section-label eyebrow: the panel's `.pels-appbar` title row ("Smart
    // task") and the kind chip ("Temperature" / "EV") already name this surface
    // twice above the hero — a "Heating smart task" eyebrow stacked the kind a
    // third time. Matches the history-detail hero, which dropped its same-word
    // kicker in the navigation-chrome unification.
    // Null on the cannot-finish branch so the chip + body postmortem aren't
    // accompanied by a redundant "Cannot finish" headline echo (per TODO 1569
    // / lived-walk 2026-05-16). The view suppresses the headline render slot
    // when this is `null`.
    headline: string | null;
    // "Why" subline beneath the queued headline ("Cheaper than now — starts at
    // HH:MM" / "Waiting for tomorrow's prices through HH:MM" / "Today's
    // budget is full — next cheap window after midnight"). Null when the
    // hero is not queued or no reason applies — the view suppresses the line
    // rather than render fabricated copy.
    headlineReason: string | null;
    subline: string;
    // At-a-glance stat pairs (Needs / Estimated cost) with bold values — the
    // former grey `Needs … · Cost ≈ …` metadata wall, promoted so the payoff
    // numbers read without hunting. Estimated cost is omitted when the scheme
    // carries no cost unit. Labels come from `SMART_TASK_HERO_STAT_LABELS`;
    // resolved producer-side.
    stats: DeadlineHeroStat[];
    // The cannot-finish REASON sentence only ("Not enough time for this
    // target. …" / "Today's daily budget is fully booked. …"). Null on
    // healthy / at-risk / queued heroes — the stats + delivered line carry
    // those. Split out of the old combined meta line so a running task shows
    // stat pairs, not a reason paragraph.
    metaLine: string | null;
    // `Delivered X of Y kWh · …` subline. Two visible branches collapse the
    // planner status union: cannot-meet renders the `still {curr} of {target}`
    // stem (the alert chip + meta line already say "Cannot finish" / "Not
    // enough time …" so this line stays magnitude-only, per TODO ~1586 /
    // 2026-05-16 live walk), every other status renders the on-track-shaped
    // form with `now …` or the `start → current` arrow. Null when there is no
    // plan to summarise (queued without allocation, no current reading, etc.).
    deliveredSoFarLine: string | null;
    // Recourse action surfaced below the meta line on cannot-finish heroes.
    // Resolved producer-side so the view dispatches on a stable slug
    // (`open_budget` / `open_overview`) rather than re-deriving cause.
    // Null when there is no action to surface (anything other than
    // `cannot_meet` / `at_risk`).
    recourse: DeadlineCannotMeetRecourse | null;
  };
  timeline: {
    ariaLabel: string;
    hours: DeadlinePlanHour[];
    // Index of the hour column containing "now" — the default readout
    // selection and the position of the "Now" axis label + now markLine.
    // Not necessarily 0: the window opens at the plan's original revision.
    nowIndex: number;
    // Fractional category-axis coordinates (category `i` spans
    // `[i-0.5, i+0.5]`) so the now/deadline markLines sit at their TRUE
    // positions instead of snapping to a bar centre.
    nowAxisX: number;
    deadlineAxisX: number;
    // "deadline Sun 09:00" markLine label, producer-composed.
    deadlineMarkLabel: string;
    // "Picked N of M hours before the deadline · avg P kr/kWh" trust
    // caption rendered under the chart. Resolved producer-side from the
    // per-hour `priceValue` + `planned` flag via `formatCheapestHoursCaption`
    // so the view never re-derives the averages or branches on price unit.
    // Null when the summary can't be stated honestly (no planned hours, a
    // single-hour window, or a missing price unit).
    cheapestHoursCaption: string | null;
    // The registered `using your solar` reason line, present only when a
    // prosumer's per-hour PLANNING price (what the schedule chart + readout
    // show) visibly diverges from the import money price (what the hero's
    // cost line shows). Bridges that gap so the ~3× planning-vs-import figure
    // difference is explained. Null for a non-prosumer (byte-identical).
    planningPriceNote: string | null;
  };
  trajectory: DeadlineTrajectoryPayload;
  planInputs: {
    perUnitRateLabel: string | null;
    perUnitRateNote: string | null;
    maxPowerLabel: string | null;
    maxPowerNote: string | null;
    extraPermissionsValue: string | null;
    // EV learning provenance rows (source, learned value, readings used,
    // latest reading timestamp). Pre-resolved at the producer side so the view
    // never branches on `kwhPerUnitProvenance.source` or null fields.
    // Empty array when no provenance is available.
    provenanceRows: KwhPerUnitProvenanceRow[];
  };
  // Resolved most-recent-first revision-log rows for the inline "Revision
  // history" `<details>` panel. The producer (`deadlinePlan.ts`) computes
  // these from the active plan's `latest` + `history` via
  // `buildActivePlanRevisionLog`. Sharing the row shape with the
  // post-finalization log (`.plan-revision-row` CSS) keeps the visual binding
  // identical across both surfaces. The view consults `revisionSummary`
  // (not `revisionLog.length`) to gate panel visibility — a brand-new
  // task whose only revision was a user-fired Flow card has rows but no
  // narrative the user doesn't already know.
  revisionLog: ActivePlanRevisionLogRow[];
  // Producer-side summary for the collapsed `<summary>` line plus the
  // visibility gate. `shouldShowPanel` is false when every revision was a
  // direct user action (panel adds no system-narrative value); `text` is
  // the pre-formatted reason+time+diff line that replaces the bare count.
  revisionSummary: ActivePlanRevisionLogSummary;
};

export type { DeadlinePlanHistoryView } from '../deadlinePlanHistoryFetch.ts';

export type DeadlinePlanPendingPayload = {
  kind: DeferredObjectiveSettingsKind;
  actionMode: 'clear_only' | 'edit_and_clear';
  labels: DeadlineLabels;
  hero: {
    chips: DeadlinePlanChip[];
    sectionLabel: string;
    headline: string;
    // Per-pending-reason "why is this still building?" subline (e.g.
    // "PELS can't read the current temperature from Connected 300."). Null
    // when the resolver declines to fabricate one. Mirrors the queued-hero
    // headlineReason on the ready payload — same render slot, same suppress
    // semantics.
    headlineReason: string | null;
    subline: string;
    metaLine: string;
    // Optional CTA mirroring the cannot-meet recourse pattern. Resolved
    // producer-side so the view dispatches on a stable shell-tab slug and
    // never branches on pendingReason. Null when no in-app action applies
    // (e.g. `awaiting_horizon_plan`, EV `invalid_session`).
    recourse: DeadlineCannotMeetRecourse | null;
  };
};

// Edit/clear lane props for the detail page. The snapshot is the module-scope
// controller state from `smartTaskEdit.ts` (`null` = editor closed) — the
// draft deliberately does NOT live in this component tree because the mount
// re-renders the whole root on every runtime refresh (see
// `buildSmartTaskEditProps` in `deadlinePlanMount.ts`). The callbacks are the
// controller's actions, threaded as props per views/AGENTS.md.
export type SmartTaskEditProps = {
  mode: DeadlinePlanPendingPayload['actionMode'];
  snapshot: SmartTaskEditSnapshot | null;
  onOpen: () => void;
  onClose: () => void;
  onReadyByInput: (value: string) => void;
  onTargetInput: (value: string) => void;
  onPermissionToggle: (key: SmartTaskEditPermissionKey, value: boolean) => void;
  onSave: () => void;
  onClear: () => void;
};

export type DeadlinePlanLoadState =
  | { status: 'error'; message: string; onRetry?: () => void; history?: DeadlinePlanHistoryView }
  | { status: 'loading'; history?: DeadlinePlanHistoryView }
  | {
    status: 'pending';
    pending: DeadlinePlanPendingPayload;
    history?: DeadlinePlanHistoryView;
    // Present when the page has an editable task; undefined hides the lane
    // (no boot yet, task absent/disabled).
    edit?: SmartTaskEditProps;
  }
  | {
    status: 'unavailable';
    objectiveKind: DeferredObjectiveSettingsKind;
    reason: DeadlinePlanUnavailableReason;
    history?: DeadlinePlanHistoryView;
  }
  | {
    // Deadline has passed or the runtime auto-disabled the objective. The
    // root lands on the History tab so the user sees outcomes rather than
    // a stale current plan.
    status: 'completed';
    objectiveKind: DeferredObjectiveSettingsKind;
    history?: DeadlinePlanHistoryView;
  }
  | {
    status: 'ready';
    payload: DeadlinePlanPayload;
    history?: DeadlinePlanHistoryView;
    edit?: SmartTaskEditProps;
  }
  | {
    // Detail view for a finalized plan in history. The page lands on the
    // History tab and shows the entry's recorded plan snapshots instead of
    // the live planner output.
    status: 'history-detail';
    entry: ResolvedDeferredObjectivePlanHistoryEntry;
    timeZone: string;
    history?: DeadlinePlanHistoryView;
  }
  | {
    // The URL referenced a historyId that no longer exists (entry rolled off
    // the cap, or settings were cleared). Lands on History so the user can
    // see what is still available.
    status: 'history-missing';
    history?: DeadlinePlanHistoryView;
  };

const chipClass = (tone: DeadlinePlanChipTone): string => `plan-chip plan-chip--${tone}`;

const DeadlineHero = ({ payload }: { payload: DeadlinePlanPayload }) => (
  <section class="plan-hero pels-hero" data-tone={payload.hero.tone} aria-labelledby="deadline-plan-title">
    <div class="plan-hero__chips">
      {payload.hero.chips.map((chip) => (
        <span
          key={chip.text}
          class={chipClass(chip.tone)}
          data-pulse={chip.pulse ? 'true' : undefined}
        >
          {chip.text}
        </span>
      ))}
    </div>
    <div class="plan-hero__section">
      {payload.hero.headline !== null && (
        <h2 class="plan-hero__headline">{payload.hero.headline}</h2>
      )}
      {payload.hero.headlineReason !== null && (
        <div class="plan-hero__subline plan-hero__subline--reason">{payload.hero.headlineReason}</div>
      )}
      {/* On-track status row: the trajectory's verdict, hoisted onto the hero
          so "am I on track?" is answerable above the fold — the same answer
          the list card gives via its status chip — without scrolling to the
          stateline under the trajectory chart. Shown only on the healthy
          (`good`) branch; the at-risk / cannot-finish chips already carry the
          warning states, and the producer nulls the verdict on the danger
          branch, so this never contradicts them. */}
      {payload.hero.tone === 'good' && payload.trajectory.stateline.verdict !== null && (
        <p class="deadline-hero-status">
          <CheckCircleIcon class="deadline-hero-status__icon" />
          <span class="deadline-hero-status__label">{payload.trajectory.stateline.verdict.label}</span>
          <span class="deadline-hero-status__supporting">
            {payload.trajectory.stateline.verdict.supporting}
          </span>
        </p>
      )}
      <div class="plan-hero__subline">{payload.hero.subline}</div>
      {payload.hero.metaLine !== null && (
        <div class="plan-hero__subline plan-hero__subline--reason">{payload.hero.metaLine}</div>
      )}
      {payload.hero.stats.length > 0 && (
        <dl class="deadline-hero-stats">
          {payload.hero.stats.map((stat) => (
            <div class="deadline-hero-stats__pair" key={stat.label}>
              <dt class="deadline-hero-stats__label">{stat.label}</dt>
              <dd class="deadline-hero-stats__value">{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {payload.hero.deliveredSoFarLine !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{payload.hero.deliveredSoFarLine}</div>
      )}
      {payload.hero.recourse !== null && (
        <div class="plan-hero__recourse">
          <button
            type="button"
            class="pels-button hy-nostyle"
            data-deadline-recourse-tab={payload.hero.recourse.targetTab}
            data-deadline-recourse-device-id={payload.hero.recourse.deviceId ?? ''}
          >
            {payload.hero.recourse.label}
          </button>
        </div>
      )}
    </div>
  </section>
);

export type DeadlineChartPalette = {
  // Picked-hour bar fill on the schedule chart: one hue, two states — picked
  // hours filled, other hours the same hue dimmed/outlined. Mint per the
  // semantic viz palette (`pels.chart.picked`).
  picked: string;
  // Accent series colour: run-band tint, measured trajectory line, now dot.
  // Mint (`pels.chart.actual`) — measured/delivered ink, the same family as
  // the picked bars. The band uses it at low opacity so the run range reads
  // as a wash behind the staircase.
  accent: string;
  // Projected staircase ahead of now — ice-blue (`pels.chart.forecast`), the
  // palette's projection ink, so the trajectory forecast speaks the same
  // language as the Budget chart's dotted projection and stays
  // distinguishable from the muted target/deadline reference lines.
  forecast: string;
  // Muted guide colour for the target/deadline reference lines and labels.
  muted: string;
  grid: string;
  text: string;
  danger: string;
};

// `fallback` is consulted only when the computed value is empty (token missing
// or renamed). Tokens are committed alongside this code, so this is defense in
// depth rather than a normal code path.
const cssVar = (element: HTMLElement, variable: string, fallback = ''): string => (
  getComputedStyle(element).getPropertyValue(variable).trim() || fallback
);

const cssNumber = (element: HTMLElement, variable: string, fallback: number): number => {
  const raw = cssVar(element, variable);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolvePalette = (element: HTMLElement): DeadlineChartPalette => ({
  picked: cssVar(element, '--pels-chart-picked'),
  // Mint measured/delivered ink per the semantic viz palette — the trajectory
  // measured line, now dot, and run-band tint. (Previously the saturated
  // grass-green accent role, which sat outside the viz palette.)
  accent: cssVar(element, '--pels-chart-actual'),
  forecast: cssVar(element, '--pels-chart-forecast'),
  muted: cssVar(element, '--pels-text-supporting-color'),
  grid: cssVar(element, '--pels-surface-outline'),
  text: cssVar(element, '--text'),
  danger: cssVar(element, '--color-role-danger'),
});

export type ChartTypography = {
  labelFontSize: number;
};

const resolveTypography = (element: HTMLElement): ChartTypography => ({
  labelFontSize: cssNumber(element, '--font-size-xs', 11),
});

// Container-specific sizers. Fallback heights must match the
// `.deadline-schedule-chart` / `.deadline-trajectory-chart` rules in
// style.css so a cold-mount inside a hidden panel sizes the chart
// consistently with the post-resize value.
const resolveChartSizeWithFallback = (fallbackHeight: number) => (
  (element: HTMLElement): { height: number; width: number } => {
    const width = element.clientWidth > 0 ? element.clientWidth : (element.parentElement?.clientWidth ?? 390);
    const viewportWidth = document.documentElement?.clientWidth ?? 0;
    return {
      width: width > 0 ? width : Math.min(480, viewportWidth || 390),
      height: element.clientHeight > 0 ? element.clientHeight : fallbackHeight,
    };
  }
);

const SCHEDULE_CHART_HEIGHT = 190;
const TRAJECTORY_CHART_HEIGHT = 160;
const resolveScheduleChartSize = resolveChartSizeWithFallback(SCHEDULE_CHART_HEIGHT);
const resolveTrajectoryChartSize = resolveChartSizeWithFallback(TRAJECTORY_CHART_HEIGHT);

const ONE_HOUR_MS = 60 * 60 * 1000;

// Schedule chart ("When will it run, and at what price?"): one grid, one
// zero-baselined price axis on the right, one-hue-two-states price bars —
// picked hours are filled mint, other hours the same hue dimmed and outlined
// (the bar height already carries the price, so price-level colour-coding
// stays off this chart; the caption key under the chart decodes the two
// states). A dot markPoint marks changed hours (replaces the undiscoverable
// 1px border), and now/deadline markLines sit at their TRUE fractional
// x-positions. The markArea band over the planned range was dropped: the
// filled bars themselves now carry "when it runs", and the kind verb lives on
// the trajectory chart's labelled run band. No legend; the ECharts tooltip is
// fully disabled — the pinned readout row below the chart is the only
// tap/scrub surface, so a floating box would double-fire.
export const buildScheduleChartOption = (
  payload: DeadlinePlanPayload,
  palette: DeadlineChartPalette,
  typography: ChartTypography,
): EChartsOption => {
  const { timeline } = payload;
  const hourCount = timeline.hours.length;
  const labels = timeline.hours.map((hour) => hour.time);
  const showLabelEvery = hourCount > 10 ? 4 : 3;
  // Keep the price axis anchored at zero for normal non-negative prices so
  // bar heights are honest. Nord Pool can go negative; in that case the lower
  // bound follows the data so those hours remain visible instead of being
  // flattened into the zero line.
  const priceValues = timeline.hours.map((hour) => hour.priceValue);
  const rawPriceMin = priceValues.length ? Math.min(...priceValues) : 0;
  const rawPriceMax = priceValues.length ? Math.max(...priceValues) : 0;
  const priceAxisMin = rawPriceMin < 0 ? rawPriceMin : 0;
  const priceMax = rawPriceMax > 0 ? rawPriceMax : (priceAxisMin < 0 ? 0 : 1);
  // Changed-hour dot sits a fixed fraction of the axis span above the bar so
  // it clears the bar cap at every viewport without per-bar measurements.
  const changedDotOffset = (priceMax - priceAxisMin) * 0.07;
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    grid: { left: 8, right: 12, top: 24, bottom: 24, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: true,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: typography.labelFontSize,
        // Evenly spaced hour ticks, anchored at the "Now" column so the
        // cadence includes it — never the old mixed rule that also forced
        // the final column and produced adjacent-label crowding (20:00 21:00).
        interval: (index: number) => (
          (index - timeline.nowIndex) % showLabelEvery === 0
        ),
        formatter: (value: string, index: number) => (
          index === timeline.nowIndex ? NOW_MARKER_WORD : value
        ),
      },
    },
    yAxis: {
      type: 'value',
      position: 'right',
      min: priceAxisMin,
      max: priceMax,
      // Halved span = a mid gridline between min and max, so the plot carries
      // three horizontal guides instead of two without crowding the axis at
      // 320 px.
      interval: Math.max(0.01, (priceMax - priceAxisMin) / 2),
      splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.text,
        fontSize: typography.labelFontSize,
        // One-decimal precision matches the Budget chart's price axis so
        // users see the same number format on both surfaces (the readout
        // retains two-decimal precision via `formatPrice` in
        // `deadlinePlan.ts`). The unit is anchored to the top tick's number —
        // one `0.6 kr/kWh` label instead of a floating unit — and the grid's
        // `containLabel` reserves its width.
        formatter: (value: number) => {
          if (priceAxisMin < 0 && Math.abs(value - priceAxisMin) < 0.001) return priceAxisMin.toFixed(1);
          if (Math.abs(value - priceMax) < 0.001) return `${priceMax.toFixed(1)} ${payload.priceUnitLabel}`;
          return '';
        },
      },
    },
    series: [
      {
        id: 'price',
        name: 'Price',
        type: 'bar',
        barCategoryGap: '25%',
        barMinHeight: 3,
        // One hue, two states: picked hours are filled mint; hours the task
        // can use but didn't pick keep the same hue as a dim outlined shell,
        // so "which hours run" is answerable at a glance without a colour
        // code for price levels (the bar height is the price).
        data: timeline.hours.map((hour) => ({
          value: hour.priceValue,
          itemStyle: hour.planned
            ? {
              color: palette.picked,
              opacity: 1,
              borderRadius: [3, 3, 0, 0],
            }
            : {
              color: palette.picked,
              opacity: 0.3,
              borderColor: palette.picked,
              borderWidth: 1,
              borderType: 'solid' as const,
              borderRadius: [3, 3, 0, 0],
            },
        })),
        // Selected-hour highlight, driven imperatively via
        // `dispatchAction({type:'highlight'})` from the scrub handler. The
        // border alone carries the selection; opacity is deliberately NOT
        // overridden so the selected bar keeps its picked/unpicked channel
        // (ECharts emphasis inherits unspecified itemStyle props per-datum).
        emphasis: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
        markPoint: {
          silent: true,
          symbol: 'circle',
          symbolSize: 5,
          itemStyle: { color: palette.text },
          label: { show: false },
          data: timeline.hours.flatMap((hour, index) => (
            hour.changed
              ? [{ coord: [index, Math.max(hour.priceValue, 0) + changedDotOffset] }]
              : []
          )),
        },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            {
              xAxis: timeline.nowAxisX,
              lineStyle: { color: palette.muted, type: 'dashed' as const, width: 1 },
              label: { show: false },
            },
            {
              xAxis: timeline.deadlineAxisX,
              lineStyle: { color: palette.muted, type: 'dashed' as const, width: 1 },
              label: {
                show: true,
                formatter: timeline.deadlineMarkLabel,
                color: palette.muted,
                fontSize: typography.labelFontSize,
                position: 'insideEndTop' as const,
              },
            },
          ],
        },
      },
    ] satisfies SeriesOption[],
  };
};

// Trajectory chart ("Will it reach 65 °C in time?"): measured-so-far line +
// now dot + muted planned staircase ahead + scheduled-run bands + dashed
// target line (label anchored top-LEFT at the line start — end labels collide
// when the staircase converges on the target) + deadline markLine + optional
// shortfall gap annotation. All silent — selection feedback is the hairline
// series updated imperatively from the shared scrub state.
export const buildTrajectoryChartOption = (
  trajectory: DeadlineTrajectoryPayload,
  palette: DeadlineChartPalette,
  typography: ChartTypography,
  surfaceColor: string,
  chartWidth: number,
): EChartsOption => {
  const deadlineColor = trajectory.deadlineDanger ? palette.danger : palette.muted;
  const xSpanMs = trajectory.xMaxMs - trajectory.xMinMs;
  // Explicit, width-aware tick cadence: ~5 hour-aligned labels at full card
  // width, ~3 at narrow (≤360 px) widths where five "HH:MM" labels fuse into
  // one unreadable run. ECharts' time axis ignores `interval` and its default
  // ticks + `hideOverlap` still crowd at 320–480 px, so the formatter blanks
  // every label that doesn't sit on the chosen hour cadence (the signed-off
  // mock's idiom).
  const targetTickCount = chartWidth > 0 && chartWidth <= 360 ? 3 : 5;
  const tickIntervalMs = Math.max(1, Math.ceil(xSpanMs / ONE_HOUR_MS / targetTickCount)) * ONE_HOUR_MS;
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    grid: { left: 8, right: 34, top: 28, bottom: 22, containLabel: true },
    xAxis: {
      type: 'time',
      min: trajectory.xMinMs,
      max: trajectory.xMaxMs,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      splitLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: typography.labelFontSize,
        hideOverlap: true,
        formatter: (ms: number): string => (
          ms % tickIntervalMs === 0 ? formatHourLabel(ms) : ''
        ),
      },
    },
    yAxis: {
      type: 'value',
      min: trajectory.yMin,
      max: trajectory.yMax,
      splitLine: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: typography.labelFontSize,
        // Only the floor renders a label; the target value is carried by the
        // dashed line's own label so the axis stays quiet.
        formatter: (value: number) => (
          Math.abs(value - trajectory.yMin) < 0.001 ? trajectory.yFloorLabel : ''
        ),
      },
    },
    series: [
      {
        id: 'run-bands',
        type: 'line',
        data: [],
        silent: true,
        markArea: {
          silent: true,
          itemStyle: { color: palette.accent, opacity: 0.08 },
          label: {
            show: true,
            color: palette.accent,
            fontSize: typography.labelFontSize,
            position: 'insideBottom' as const,
          },
          data: trajectory.runBands.map((band) => ([
            { name: band.label ?? '', xAxis: band.fromMs },
            { xAxis: band.toMs },
          ])),
        },
      },
      {
        id: 'planned-staircase',
        type: 'line',
        data: trajectory.plannedPoints,
        silent: true,
        symbol: 'none',
        // Projection ink (ice-blue) — the same brightened forecast token the
        // Budget projection uses, so "projection/forecast = ice-blue" holds
        // across all three charts. NOT the muted reference grey: the
        // target/deadline lines on this same chart already own the muted tone.
        // Width 2 (over the 1 px reference lines) so the forecast reads as a
        // distinct blue staircase at 320 px, not a thin grey guide.
        lineStyle: { color: palette.forecast, width: 2 },
      },
      {
        id: 'target-line',
        type: 'line',
        silent: true,
        symbol: 'none',
        data: [
          [trajectory.xMinMs, trajectory.targetValue],
          [trajectory.xMaxMs, trajectory.targetValue],
        ],
        lineStyle: { color: palette.muted, width: 1, type: 'dashed' as const },
        markPoint: {
          silent: true,
          symbol: 'rect',
          symbolSize: 0.1,
          label: {
            show: true,
            formatter: trajectory.targetLabel,
            color: palette.muted,
            fontSize: typography.labelFontSize,
            position: 'top' as const,
            distance: 4,
          },
          data: [{ coord: [trajectory.xMinMs + xSpanMs * 0.06, trajectory.targetValue] }],
        },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: deadlineColor, width: 1, type: 'dashed' as const },
          label: {
            show: true,
            formatter: trajectory.deadlineMarkLabel,
            color: deadlineColor,
            fontSize: typography.labelFontSize,
            // Horizontal label above the line top (the mock's idiom) — the
            // grid's `top: 28` reserves the headroom. `insideEndTop` would
            // rotate the label along the vertical line.
            position: 'end' as const,
            distance: 6,
          },
          data: [{ xAxis: trajectory.deadlineAtMs }],
        },
      },
      ...(trajectory.shortfall !== null ? [{
        id: 'shortfall',
        type: 'line' as const,
        silent: true,
        symbol: 'none',
        data: [
          [trajectory.deadlineAtMs, trajectory.shortfall.fromValue],
          [trajectory.deadlineAtMs, trajectory.shortfall.toValue],
        ],
        lineStyle: { color: palette.danger, width: 2 },
        markPoint: {
          silent: true,
          symbol: 'rect',
          symbolSize: 0.1,
          label: {
            show: true,
            formatter: trajectory.shortfall.label,
            color: palette.danger,
            fontSize: typography.labelFontSize,
            position: 'left' as const,
            distance: 8,
          },
          data: [{
            coord: [
              trajectory.deadlineAtMs,
              (trajectory.shortfall.fromValue + trajectory.shortfall.toValue) / 2,
            ],
          }],
        },
      }] : []),
      {
        id: 'measured',
        type: 'line',
        data: trajectory.measuredPoints,
        silent: true,
        symbol: 'none',
        smooth: 0.4,
        lineStyle: { color: palette.accent, width: 2.5 },
      },
      {
        id: 'now-dot',
        type: 'scatter',
        data: [trajectory.nowPoint],
        silent: true,
        symbolSize: 9,
        itemStyle: { color: palette.accent, borderColor: surfaceColor, borderWidth: 2 },
      },
      {
        // Selection hairline, fed imperatively from the shared scrub state.
        id: 'selection-hairline',
        type: 'line',
        data: [],
        silent: true,
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: palette.text, width: 1, opacity: 0.5 },
          label: { show: false },
          data: [],
        },
      },
    ] satisfies SeriesOption[],
  };
};

// ─── Scrub interaction ───────────────────────────────────────────────────────
//
// `attachHourScrub` / `resolveScrubHourIndex` moved to `../deadlineChartScrub.ts`
// (Phase 1B) so the history-detail trajectory chart shares the exact wiring.

const ScheduleChart = ({ payload, selectedIndex, onSelect }: {
  payload: DeadlinePlanPayload;
  selectedIndex: number;
  onSelect: (index: number | null) => void;
}) => {
  const hourCount = payload.timeline.hours.length;
  const chartHandle = useRef<EChartsType | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const chartRef = useEchartsMount({
    buildOption: (container) => buildScheduleChartOption(
      payload,
      resolvePalette(container),
      resolveTypography(container),
    ),
    resolveSize: resolveScheduleChartSize,
    deps: [payload],
    onChartInit: (chart) => {
      chartHandle.current = chart;
      attachHourScrub(
        chart,
        // Column-tolerant pixel→hour resolution shared with the Usage-tab
        // pinned readouts (`chartReadout.ts`).
        (x, y) => resolveCategoryIndexFromPixel(chart, x, y, hourCount),
        (index) => onSelectRef.current(index),
      );
    },
  });
  // Imperative highlight of the selected bar. Runs after the mount effect on
  // both cold mount and `payload` remounts (hooks run in registration order),
  // so the handle always points at the live chart.
  useEffect(() => {
    const chart = chartHandle.current;
    if (!chart || chart.isDisposed()) return;
    chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
    chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: selectedIndex });
  }, [selectedIndex, payload]);
  return <div ref={chartRef} class="deadline-schedule-chart" role="img" aria-label={payload.timeline.ariaLabel} />;
};

const TrajectoryChart = ({ payload, selectedHourMs, onSelect }: {
  payload: DeadlinePlanPayload;
  // Hour-start ms of an EXPLICIT selection; null at the default state so the
  // hairline doesn't crowd the now dot at rest.
  selectedHourMs: number | null;
  onSelect: (index: number | null) => void;
}) => {
  const { trajectory } = payload;
  const hours = payload.timeline.hours;
  const chartHandle = useRef<EChartsType | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const chartRef = useEchartsMount({
    buildOption: (container) => buildTrajectoryChartOption(
      trajectory,
      resolvePalette(container),
      resolveTypography(container),
      // Now-dot ring colour = the card surface behind the chart, so the dot
      // reads as punched out of the measured line.
      cssVar(container, '--pels-surface-container-lowest', 'transparent'),
      // Width drives the time-axis label cadence (~3 labels at ≤360 px).
      // Same sizer the mount hook uses, so the cadence matches the rendered
      // width even on a cold mount inside a hidden panel.
      resolveTrajectoryChartSize(container).width,
    ),
    resolveSize: resolveTrajectoryChartSize,
    deps: [payload],
    onChartInit: (chart) => {
      chartHandle.current = chart;
      attachHourScrub(
        chart,
        (x, y) => {
          if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
          // Scalar pixel for the single-axis finder (see ScheduleChart note).
          const raw = chart.convertFromPixel({ xAxisIndex: 0 }, x);
          const ms = Array.isArray(raw) ? raw[0] : raw;
          if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
          return resolveScrubHourIndex(hours, ms);
        },
        (index) => onSelectRef.current(index),
      );
    },
  });
  // Selection hairline at the selected hour's centre, merged onto the
  // `selection-hairline` series by id. Only `markLine.data` changes; the
  // line style was baked into the initial option with the live palette.
  useEffect(() => {
    const chart = chartHandle.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption({
      series: [{
        id: 'selection-hairline',
        markLine: {
          data: selectedHourMs === null ? [] : [{ xAxis: selectedHourMs + ONE_HOUR_MS / 2 }],
        },
      }],
    });
  }, [selectedHourMs, payload]);
  return <div ref={chartRef} class="deadline-trajectory-chart" role="img" aria-label={trajectory.ariaLabel} />;
};

// The two question cards + the pinned readout row. Selection is shared: a
// scrub on either chart drives the readout under chart 1, the emphasis
// border on the selected bar, and the hairline on chart 2. `null` selection
// = the default (the "Now" hour) — the readout is never empty.
const ScheduleQuestionCards = ({ payload }: { payload: DeadlinePlanPayload }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const hours = payload.timeline.hours;
  const effectiveIndex = selected !== null && selected >= 0 && selected < hours.length
    ? selected
    : payload.timeline.nowIndex;
  const hour = hours[effectiveIndex];
  // At-rest (no explicit selection yet) the secondary line is always the
  // scrub hint — discoverability of the gesture beats the default Now hour's
  // revision narrative, which reappears as soon as the user actively selects
  // any hour (including re-selecting Now). The branch is on interaction state
  // only; the view never inspects why `readout.secondary` exists.
  const readoutSecondary = selected === null
    ? SMART_TASK_READOUT_SCRUB_HINT
    : (hour?.readout.secondary ?? SMART_TASK_READOUT_SCRUB_HINT);
  const stateline = payload.trajectory.stateline;
  return (
    <>
      <section
        class="pels-surface-card budget-redesign-card deadline-horizon-card"
        aria-labelledby="deadline-schedule-title"
      >
        <div class="budget-card-header">
          <h2 class="plan-card__title" id="deadline-schedule-title">{SMART_TASK_SCHEDULE_CARD_TITLE}</h2>
        </div>
        <ScheduleChart payload={payload} selectedIndex={effectiveIndex} onSelect={setSelected} />
        <div class="deadline-readout" aria-live="polite">
          <div class="deadline-readout__primary">{hour?.readout.primary}</div>
          <div class="deadline-readout__secondary">{readoutSecondary}</div>
        </div>
        {payload.timeline.cheapestHoursCaption && (
          <p class="deadline-horizon-caption pels-card-supporting">{payload.timeline.cheapestHoursCaption}</p>
        )}
        <p class="deadline-horizon-caption pels-card-supporting">{SMART_TASK_SCHEDULE_CHART_KEY}</p>
        {payload.timeline.planningPriceNote && (
          <p class="deadline-horizon-caption pels-card-supporting">{payload.timeline.planningPriceNote}</p>
        )}
      </section>
      <section
        class="pels-surface-card budget-redesign-card deadline-horizon-card"
        aria-labelledby="deadline-trajectory-title"
      >
        <div class="budget-card-header">
          <h2 class="plan-card__title" id="deadline-trajectory-title">{payload.trajectory.cardTitle}</h2>
        </div>
        <TrajectoryChart
          payload={payload}
          selectedHourMs={selected !== null ? (hours[effectiveIndex]?.startsAtMs ?? null) : null}
          onSelect={setSelected}
        />
        <p class={stateline.tone === 'danger' ? 'deadline-stateline deadline-stateline--danger' : 'deadline-stateline'}>
          <strong class="deadline-stateline__emphasis">{stateline.emphasis}</strong>
          {` · ${stateline.rest}`}
        </p>
      </section>
    </>
  );
};

// Refresh cadence for the "Latest reading used" freshness string. One minute
// matches the granularity of `formatLastSampleValue` ("Updated N min ago") so
// the user sees the counter advance roughly as their wall clock crosses the
// next minute boundary. Anything faster would just re-render with the same
// string; anything slower would leave the user staring at "Updated just now"
// for too long (the bug TODO ~line 1160 was opened against).
const FRESHNESS_TICK_MS = 60 * 1000;

// Subscribes the calling component to a `nowMs` value that updates every
// `FRESHNESS_TICK_MS` ms while the component is mounted. The interval is
// component-local (not a module-level singleton) so multiple mounts/unmounts
// — including Preact strict-mode double-mounts during dev — do not leak
// timers. Returns `null` when `enabled` is false so the calling row keeps
// rendering the producer-supplied `value` verbatim.
const useFreshnessTick = (enabled: boolean): number | null => {
  // Lazy initializer so `Date.now()` is only called when needed, and only on
  // the very first render. Cold mount with `enabled=true` paints from this
  // seed; the interval below takes over from the second frame onward.
  const [nowMs, setNowMs] = useState<number | null>(() => (enabled ? Date.now() : null));
  useEffect(() => {
    if (!enabled) {
      // If the row stops needing freshness (provenance disappears mid-mount),
      // drop the cached `nowMs` so a later re-enable seeds from a fresh
      // `Date.now()` rather than the stale value from the prior session.
      setNowMs((current) => (current === null ? current : null));
      return undefined;
    }
    // On a false → true transition mid-mount, seed immediately so the row
    // does not wait a full tick before painting against a fresh clock; on
    // the cold mount, `useState`'s lazy initializer already supplied a
    // current value, and skipping the eager `setNowMs` here avoids an extra
    // render whenever wall-clock time advances by ≥1 ms between the
    // initializer running and the effect committing.
    setNowMs((current) => (current === null ? Date.now() : current));
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, FRESHNESS_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [enabled]);
  return nowMs;
};

// Re-derives `{ value, tone }` for the "Latest reading used" row from its
// raw timestamp whenever the row carries a `freshnessOfMs`. Falls back to
// the producer-supplied pair while the tick has not seeded `nowMs` yet, or
// for rows that have no freshness field (Source, Readings used). Keeping the
// read in the view layer so the producer stays time-independent — the
// producer's `nowMs` is just the seed value. The view re-derives `tone` (not
// just `value`) so the warn affordance can flip on as soon as a sample
// crosses the 24 h staleness threshold while the page is open.
const renderProvenanceRowDisplay = (
  row: KwhPerUnitProvenanceRow,
  nowMs: number | null,
): { value: string; tone: KwhPerUnitProvenanceRow['tone'] } => {
  if (typeof row.freshnessOfMs !== 'number' || nowMs === null) {
    return { value: row.value, tone: row.tone };
  }
  const fresh = formatLastSampleValue({
    lastMs: row.freshnessOfMs,
    nowMs,
    formatAcceptedAt,
  });
  return { value: fresh.text, tone: fresh.tone };
};

// Exported for unit tests so the freshness tick can be exercised in isolation
// without also mounting `HorizonChart` (whose ECharts init via
// `useEchartsMount` hits real ECharts subpaths the JSDOM-aliased shim doesn't
// fully cover). The production render path still routes through
// `DeadlinePlanRoot` below.
// `editorOpen` suppresses the read-only "Extra permissions" row while the
// editor above owns the same setting: two blocks under the same label, one
// showing the saved value and one the unsaved draft, disagree the moment a
// toggle moves and nothing on screen says which is which. The row is still the
// only place the granted set appears at rest, so it comes back on close.
export const PlanInputsCard = ({ payload, editorOpen = false }: {
  payload: DeadlinePlanPayload;
  editorOpen?: boolean;
}) => {
  const {
    perUnitRateLabel,
    perUnitRateNote,
    maxPowerLabel,
    maxPowerNote,
    provenanceRows,
  } = payload.planInputs;
  const extraPermissionsValue = editorOpen ? null : payload.planInputs.extraPermissionsValue;
  // Only arm the 60s tick when at least one row actually needs freshness; on
  // a bootstrap provenance row (Starting estimate only) or no provenance at
  // all the timer never spins up.
  const hasFreshnessRow = provenanceRows.some((row) => typeof row.freshnessOfMs === 'number');
  const tickNowMs = useFreshnessTick(hasFreshnessRow);
  if (
    perUnitRateLabel === null
    && maxPowerLabel === null
    && extraPermissionsValue === null
    && provenanceRows.length === 0
  ) return null;
  return (
    <section class="pels-surface-card budget-redesign-card" aria-labelledby="deadline-plan-inputs-title">
      <div class="budget-card-header">
        <h2 class="plan-card__title" id="deadline-plan-inputs-title">{payload.labels.planInputsCardTitle}</h2>
      </div>
      <dl class="plan-inputs__list">
        {perUnitRateLabel !== null && (
          <div class="plan-inputs__row">
            <dt class="plan-inputs__row-label">{payload.labels.planInputsRateRowLabel}</dt>
            <dd class="plan-inputs__row-value">
              {perUnitRateLabel}
              {perUnitRateNote !== null && (
                <div class="plan-inputs__row-note">{perUnitRateNote}</div>
              )}
            </dd>
          </div>
        )}
        {maxPowerLabel !== null && (
          <div class="plan-inputs__row">
            <dt class="plan-inputs__row-label">{payload.labels.planInputsMaxPowerRowLabel}</dt>
            <dd class="plan-inputs__row-value">
              {maxPowerLabel}
              {maxPowerNote !== null && (
                <div class="plan-inputs__row-note">{maxPowerNote}</div>
              )}
            </dd>
          </div>
        )}
        {extraPermissionsValue !== null && (
          <div class="plan-inputs__row">
            <dt class="plan-inputs__row-label">{SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL}</dt>
            <dd class="plan-inputs__row-value">{extraPermissionsValue}</dd>
          </div>
        )}
        {provenanceRows.map((row) => {
          const display = renderProvenanceRowDisplay(row, tickNowMs);
          return (
            <div key={row.label} class="plan-inputs__row">
              <dt class="plan-inputs__row-label">{row.label}</dt>
              <dd
                class={display.tone === null
                  ? 'plan-inputs__row-value'
                  : `plan-inputs__row-value plan-inputs__row-value--${display.tone}`}
              >
                {display.value}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
};


// PendingHero mirrors `DeadlineHero` for the active-plan ready path: the
// headlineReason subline sits directly below the headline (same render slot
// as the queued-hero "why" subline) and the recourse button reuses the
// canonical `.pels-button` shape so the dispatcher in `deadlinePlanMount.ts`
// handles both surfaces with a single delegated click handler. The view
// never branches on pendingReason — both fields arrive pre-resolved from
// the producer.
const PendingHero = ({ pending }: { pending: DeadlinePlanPendingPayload }) => (
  <section class="plan-hero pels-hero" data-tone="info" aria-labelledby="deadline-plan-pending-title">
    <div class="plan-hero__chips">
      {pending.hero.chips.map((chip) => (
        <span
          key={chip.text}
          class={chipClass(chip.tone)}
          data-pulse={chip.pulse ? 'true' : undefined}
        >
          {chip.text}
        </span>
      ))}
    </div>
    <div class="plan-hero__section">
      <p class="eyebrow plan-hero__section-label" id="deadline-plan-pending-title">{pending.hero.sectionLabel}</p>
      <h2 class="plan-hero__headline">{pending.hero.headline}</h2>
      {pending.hero.headlineReason !== null && (
        <div class="plan-hero__subline plan-hero__subline--reason">{pending.hero.headlineReason}</div>
      )}
      <div class="plan-hero__subline">{pending.hero.subline}</div>
      {/* `metaLine` on the pending hero carries the "why is this still
       * building?" copy (e.g. "PELS needs a current state of charge…"). This
       * is the most actionable string on the surface, so it renders at the
       * primary on-surface tone via `--action` instead of the secondary
       * `--muted` tone the ready hero uses for its meta/cost recap lines. */}
      <div class="plan-hero__subline plan-hero__subline--action">{pending.hero.metaLine}</div>
      {pending.hero.recourse !== null && (
        <div class="plan-hero__recourse">
          <button
            type="button"
            class="pels-button hy-nostyle"
            data-deadline-recourse-tab={pending.hero.recourse.targetTab}
            data-deadline-recourse-device-id={pending.hero.recourse.deviceId ?? ''}
          >
            {pending.hero.recourse.label}
          </button>
        </div>
      )}
    </div>
  </section>
);

// Embeds the device-scoped past-runs list beneath the pending hero so the
// user always sees their history evidence even when the live plan is still
// warming up. Reuses the same `DeadlinesHistoryListRoot` the Smart-tasks tab
// uses, so the empty-state copy, week grouping, and miss-streak badges stay
// identical across surfaces. Renders nothing when no history has been fetched
// yet or the device has no recorded entries — we intentionally suppress the
// "Past tasks" heading in the empty case so a brand-new device with no prior
// runs doesn't get a cosmetic empty section directly under the pending hero.
const PriorRunsHistory = ({ history }: {
  history: DeadlinePlanHistoryView | undefined;
}) => {
  if (!history || history.entries.length === 0) return null;
  return (
    <DeadlinesHistoryListRoot
      state={{
        status: 'ready',
        entries: history.entries,
        timeZone: history.timeZone,
      }}
    />
  );
};

// Inline edit/clear card below the hero. Collapsed: one quiet row offering the
// action. Open: goal + ready-by fields, the server-previewed landing line
// ("If you save: runs … · Ready by Tomorrow 07:00" — the honest, explicitly
// conditional display of where the typed HH:mm lands), the cost/feasibility
// readout, and the action row with a two-step Clear (label-swap confirm, same
// pattern as Budget's discard).
// Everything renders from the controller snapshot so a runtime refresh that
// repaints the whole root — or even flips ready → pending — redraws the open
// editor unchanged.
const SmartTaskClearControl = ({
  snapshot,
  disabled,
  onClear,
}: {
  snapshot: SmartTaskEditSnapshot | null;
  disabled: boolean;
  onClear: () => void;
}) => {
  const busyClearing = snapshot?.busy === 'clearing';
  const clearArmed = snapshot?.clearArmed === true;
  return (
    <MdTextButton
      class="smart-task-edit__clear md-text-button--destructive"
      {...(disabled ? { disabled: true } : {})}
      onClick={onClear}
    >
      {/* Stack every possible label in one grid cell and toggle visibility:
          the button is always as wide as its widest label, so arming the
          two-step confirm cannot move the tap target. */}
      <span class="smart-task-edit__clear-labels">
        <span aria-hidden={clearArmed || busyClearing ? 'true' : undefined} data-active={!clearArmed && !busyClearing ? 'true' : undefined}>
          {SMART_TASK_EDIT_COPY.clearButton}
        </span>
        <span aria-hidden={!clearArmed || busyClearing ? 'true' : undefined} data-active={clearArmed && !busyClearing ? 'true' : undefined}>
          {SMART_TASK_EDIT_COPY.clearConfirm}
        </span>
        <span aria-hidden={busyClearing ? undefined : 'true'} data-active={busyClearing ? 'true' : undefined}>
          {SMART_TASK_EDIT_COPY.clearing}
        </span>
      </span>
    </MdTextButton>
  );
};

/** md-switch exposes its state as a `.selected` property (Material Web interop). */
type SwitchElement = HTMLElement & { selected: boolean };

// One permission row, on the canonical `.md-switch-row` grammar every other
// enable-toggle in PELS uses (label + hint leading, switch trailing) — no
// page-local toggle primitive, per `views/AGENTS.md`. The `--disabled` modifier
// dims the LABEL only: a disabled row whose label reads at full strength looks
// like a live control that silently ignores taps, and the hint is the one line
// that explains why it's off, so it must stay the more legible of the two.
const SmartTaskPermissionRow = ({ label, hint, selected, disabled, onToggle }: {
  label: string;
  hint: string;
  selected: boolean;
  disabled: boolean;
  onToggle: (value: boolean) => void;
}) => (
  <label class={disabled ? 'md-switch-row md-switch-row--disabled' : 'md-switch-row'}>
    <MdSwitch
      aria-label={label}
      {...(selected ? { selected: true } : {})}
      {...(disabled ? { disabled: true } : {})}
      onChange={(event: Event) => onToggle((event.currentTarget as SwitchElement).selected)}
    />
    <span class="md-switch-row__content">
      <span class="md-switch-row__label pels-text-settings-label">{label}</span>
      <small class="field__hint">{hint}</small>
    </span>
  </label>
);

// The editor's "Extra permissions" disclosure. Collapsed by default so the
// common goal/ready-by edit stays a two-field form, but OPEN when the task
// already holds a permission — a grant the user can now revoke here must not be
// hidden behind a closed disclosure. `open` is derived from the BASELINE (fixed
// for the editor session), so the full-root repaint on every runtime refresh
// re-renders the same value and Preact leaves a manually collapsed panel alone.
//
// The limit toggle is offered where the server would keep the grant
// (`supportsLimitLowerPriority`) OR where the task already holds it. Eligibility
// blocks turning a NEW grant on; it must not hide a standing one, because a
// device that transiently reads as non-stepped after a restart would otherwise
// leave the user unable to see or revoke a permission they still have — the
// read-only row is suppressed while the editor is open, so this is the only
// surface for it. Rendering keys off the BASELINE so the row can't vanish the
// moment it is switched off. The budget exemption gates it either way: the
// controller forces it off when the exemption goes off, so a
// checked-but-unpersistable state can't be shown.
const SmartTaskPermissionsSection = ({ snapshot, disabled, onToggle }: {
  snapshot: SmartTaskEditSnapshot;
  disabled: boolean;
  onToggle: (key: SmartTaskEditPermissionKey, value: boolean) => void;
}) => {
  const { permissions } = snapshot.draft;
  const baseline = snapshot.context.baselinePermissions;
  const anyGranted = baseline.exemptFromBudget
    || baseline.limitLowerPriorityDevices
    || baseline.pauseLowerPriorityDevices;
  // What the DRAFT currently grants, joined in the canonical order. Sits outside
  // the `<details>` so it survives collapse — the same reason
  // `.plan-revision-panel__summary-subline` does. Without it a closed disclosure
  // is a bare title that answers nothing and forces a tap to learn anything.
  const grantedLine = formatGrantedRescuePermissionsLine({
    exemptFromBudget: permissions.exemptFromBudget,
    limitLowerPriorityDevices: permissions.limitLowerPriorityDevices,
    pauseLowerPriorityDevices: permissions.pauseLowerPriorityDevices,
  });
  return (
    <div class="smart-task-edit__permissions-block">
      <details class="smart-task-edit__permissions" {...(anyGranted ? { open: true } : {})}>
        <summary class="smart-task-edit__permissions-summary">
          <span class="plan-card__title">{SMART_TASK_EXTRA_PERMISSIONS_TITLE}</span>
          <ExpandMoreIcon class="disclosure-chevron" />
        </summary>
        <small class="section-hint">{SMART_TASK_EDIT_COPY.permissionsHint}</small>
        <SmartTaskPermissionRow
          label={SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget}
          hint={SMART_TASK_EXTRA_PERMISSION_HINTS.exemptFromBudget}
          selected={permissions.exemptFromBudget}
          disabled={disabled}
          onToggle={(value) => onToggle('exemptFromBudget', value)}
        />
        {(snapshot.context.supportsLimitLowerPriority || baseline.limitLowerPriorityDevices) && (
          <SmartTaskPermissionRow
            label={SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices}
            hint={permissions.exemptFromBudget
              ? SMART_TASK_EXTRA_PERMISSION_HINTS.limitLowerPriorityDevices
              : SMART_TASK_LIMIT_NEEDS_BUDGET_HINT}
            selected={permissions.limitLowerPriorityDevices}
            // Off on an ineligible device is a one-way door: the row stays (it
            // is rendered off the baseline) but can't be switched back on, since
            // the server would drop a fresh grant here as inert.
            disabled={disabled
              || !permissions.exemptFromBudget
              || (!snapshot.context.supportsLimitLowerPriority && !permissions.limitLowerPriorityDevices)}
            onToggle={(value) => onToggle('limitLowerPriorityDevices', value)}
          />
        )}
        <SmartTaskPermissionRow
          label={SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices}
          hint={SMART_TASK_EXTRA_PERMISSION_HINTS.pauseLowerPriorityDevices}
          selected={permissions.pauseLowerPriorityDevices}
          disabled={disabled}
          onToggle={(value) => onToggle('pauseLowerPriorityDevices', value)}
        />
      </details>
      {grantedLine !== null && (
        <p class="smart-task-edit__permissions-granted">{grantedLine}</p>
      )}
    </div>
  );
};

const SmartTaskEditSection = ({ edit }: { edit: SmartTaskEditProps }) => {
  const s = edit.snapshot;
  if (edit.mode === 'clear_only') {
    const busyClearing = s?.busy === 'clearing';
    return (
      <section class="pels-surface-card budget-redesign-card smart-task-edit">
        {s?.errorLine !== null && s?.errorLine !== undefined && (
          <p class="smart-task-edit__error">{s.errorLine}</p>
        )}
        <SmartTaskClearControl
          snapshot={s}
          disabled={busyClearing}
          onClear={edit.onClear}
        />
      </section>
    );
  }
  if (s === null) {
    return (
      <section class="pels-surface-card budget-redesign-card smart-task-edit">
        <div class="smart-task-edit__offer">
          <small class="section-hint">{SMART_TASK_EDIT_COPY.editHint}</small>
          <MdTextButton onClick={edit.onOpen}>{SMART_TASK_EDIT_COPY.editButton}</MdTextButton>
        </div>
      </section>
    );
  }
  const busySaving = s.busy === 'saving';
  const busyClearing = s.busy === 'clearing';
  const saveDisabled = !s.valid || !s.dirty || busySaving || busyClearing;
  return (
    <section class="pels-surface-card budget-redesign-card smart-task-edit">
      <p class="plan-card__title">{SMART_TASK_EDIT_COPY.editButton}</p>
      <label class="field">
        <span class="field__label pels-text-settings-label">{CREATE_SMART_TASK_WIDGET_COPY.goalLabel}</span>
        <MdFilledTextField
          type="number"
          inputMode="decimal"
          value={s.draft.target === null ? '' : String(s.draft.target)}
          min={String(s.context.min)}
          max={String(s.context.max)}
          step={String(s.context.step)}
          suffixText={s.context.unit}
          {...(busySaving || busyClearing ? { disabled: true } : {})}
          onInput={(event: Event) => {
            edit.onTargetInput((event.target as HTMLInputElement).value);
          }}
        />
        <small class="field__hint">
          {formatSmartTaskGoalRangeHint(s.context.min, s.context.max, s.context.unit)}
        </small>
      </label>
      <label class="field">
        <span class="field__label pels-text-settings-label">{CREATE_SMART_TASK_WIDGET_COPY.readyByLabel}</span>
        <input
          class="smart-task-edit__time-input"
          type="time"
          value={s.draft.readyBy}
          disabled={busySaving || busyClearing}
          onInput={(event: Event) => {
            edit.onReadyByInput((event.target as HTMLInputElement).value);
          }}
        />
      </label>
      <SmartTaskPermissionsSection
        snapshot={s}
        disabled={busySaving || busyClearing}
        onToggle={edit.onPermissionToggle}
      />
      {s.preview !== null && (
        <div class="smart-task-edit__preview">
          <p class="smart-task-edit__preview-when">{s.preview.whenLine}</p>
          {s.preview.verdictLine !== null && (
            <p class="smart-task-edit__preview-verdict">{s.preview.verdictLine}</p>
          )}
          {s.preview.costLine !== null && (
            <p class="smart-task-edit__preview-cost">{s.preview.costLine}</p>
          )}
          <small class="section-hint">{s.preview.caveat}</small>
        </div>
      )}
      {/* Hold the preview slot with an honest in-flight line while the
          debounced estimate round-trip runs, instead of letting the
          landing/cost lines pop in and out of the layout on every edit. */}
      {s.preview === null && s.busy === 'previewing' && (
        <p class="smart-task-edit__previewing">{SMART_TASK_EDIT_COPY.previewing}</p>
      )}
      {s.errorLine !== null && (
        <p class="smart-task-edit__error">{s.errorLine}</p>
      )}
      <div class="smart-task-edit__actions">
        <MdFilledButton
          {...(saveDisabled ? { disabled: true } : {})}
          onClick={edit.onSave}
        >
          {busySaving ? SMART_TASK_EDIT_COPY.saving : SMART_TASK_EDIT_COPY.saveButton}
        </MdFilledButton>
        <MdTextButton
          {...(busySaving || busyClearing ? { disabled: true } : {})}
          onClick={edit.onClose}
        >
          {SMART_TASK_EDIT_COPY.discardButton}
        </MdTextButton>
        <SmartTaskClearControl
          snapshot={s}
          disabled={busySaving || busyClearing}
          onClear={edit.onClear}
        />
      </div>
    </section>
  );
};

const DeadlinePlanRoot = ({ loadState }: { loadState: DeadlinePlanLoadState }) => {
  if (loadState.status === 'history-detail') {
    // `key={entry.id}` forces Preact to remount the component when the user
    // navigates between history entries (e.g., past-task list → entry A →
    // back → entry B). Without this, the local `chartCollapsed` state from
    // entry A would persist and the Succeeded receipt for entry B could
    // briefly render expanded with a stale "Hide details" toggle.
    return (
      <DeadlinePlanHistoryDetail
        key={loadState.entry.id}
        entry={loadState.entry}
        timeZone={loadState.timeZone}
      />
    );
  }
  if (loadState.status === 'history-missing') {
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">{SMART_TASK_BANNER_RECORD_NOT_FOUND_TITLE}</h1>
        <p class="pels-card-supporting">{SMART_TASK_BANNER_RECORD_NOT_FOUND_BODY}</p>
      </section>
    );
  }
  if (loadState.status === 'loading') {
    return (
      <section
        class="pels-surface-card budget-redesign-card"
        aria-busy="true"
      >
        <div class="pels-skeleton-stack" aria-hidden="true">
          <span class="pels-skeleton pels-skeleton--headline"></span>
          <span class="pels-skeleton pels-skeleton--subline"></span>
          <span class="pels-skeleton pels-skeleton--hero"></span>
          <span class="pels-skeleton pels-skeleton--card"></span>
        </div>
        <span class="visually-hidden">{SMART_TASK_LOADING_LABEL}</span>
      </section>
    );
  }
  if (loadState.status === 'error') {
    const onRetry = loadState.onRetry;
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">{SMART_TASK_BANNER_UNAVAILABLE_TITLE}</h1>
        <p class="pels-card-supporting">{loadState.message}</p>
        {onRetry && (
          <MdTextButton class="plan-card__retry" onClick={onRetry}>
            Try again
          </MdTextButton>
        )}
      </section>
    );
  }
  if (loadState.status === 'pending') {
    // A brand-new active task with prior runs used to leave a tall empty page
    // under the pending hero, hiding the history evidence the user may be
    // looking for. Render the device-scoped past tasks below the hero whenever
    // history fetched non-empty so the page never sells "there is nothing
    // here yet" while real runs sit one fold away.
    //
    // No outer `pels-surface-card` wrapper here — mirrors the `ready` branch
    // (hero + sibling cards as a fragment): `.pels-hero` is itself a
    // card-shaped surface (border, radius, surface tier) and the
    // `PriorRunsHistory` entries own their own `.pels-surface-card` stack.
    // Wrapping would double-card the hero and nest history rows inside an
    // extra container, breaking parity with `ready`. The placeholder states
    // (`loading`, `error`, `completed`, `history-missing`) wrap because they
    // have only flat copy with no hero/card primitive of their own.
    return (
      <>
        <PendingHero pending={loadState.pending} />
        {loadState.edit !== undefined && <SmartTaskEditSection edit={loadState.edit} />}
        <PriorRunsHistory history={loadState.history} />
      </>
    );
  }
  if (loadState.status === 'unavailable') {
    const copy = deadlineLabels(loadState.objectiveKind).unavailableByReason[loadState.reason];
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">{copy.headline}</h1>
        <p class="pels-card-supporting">{copy.body}</p>
      </section>
    );
  }
  if (loadState.status === 'completed') {
    const copy = deadlineLabels(loadState.objectiveKind).completedHero;
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">{copy.headline}</h1>
        <p class="pels-card-supporting">{copy.body}</p>
      </section>
    );
  }
  return (
    <>
      <DeadlineHero payload={loadState.payload} />
      {loadState.edit !== undefined && <SmartTaskEditSection edit={loadState.edit} />}
      <ScheduleQuestionCards payload={loadState.payload} />
      <PlanInputsCard payload={loadState.payload} editorOpen={loadState.edit?.snapshot != null} />
      <RevisionHistoryPanel payload={loadState.payload} />
      <PriorRunsHistory history={loadState.history} />
    </>
  );
};

// Inline "what changed" panel rendered below the plan inputs and above the
// prior-runs history. Default-collapsed `<details>` per the m3-critic
// recommendation — keeps the at-rest page shape unchanged for the common case
// (most users won't open it), surfaces the revision narrative on tap for
// power users investigating why the plan looks the way it does. Suppressed
// entirely when there are fewer than two revisions worth showing (a brand-new
// task whose only revision is `latest` would render a single redundant row).
// One-shot guard so we breadcrumb at most once per session per unknown
// reason. The set survives across panel re-mounts because it lives at
// module scope; that's intentional — if the recorder ships a new reason
// code, we want one entry in the runtime log per session, not one per
// render tick.
//
// Breadcrumbs route through `logSettingsWarn` to the runtime
// `settings_ui_log` API → `app.log(...)`, so the signal lands in the
// app's stdout log (`/tmp/pels/start.*.stdout.log`) where new reason
// codes are actually noticed; the settings UI's `console` is invisible
// to users in the Homey WebView and out of scope for ops anyway.
const warnedFallbackRevisions = new Set<string>();

const noteFallbackRevisions = (rows: readonly ActivePlanRevisionLogRow[]): void => {
  for (const row of rows) {
    if (!row.isFallback) continue;
    const key = `r${row.revision}@${row.timeLabel}`;
    if (warnedFallbackRevisions.has(key)) continue;
    warnedFallbackRevisions.add(key);
    void logSettingsWarn(
      `Revision ${row.revision} (${row.timeLabel}) has an unknown reason code; rendered as fallback label. Update REVISION_REASON_LABEL in deadlineLabels.ts.`,
      undefined,
      'deadline_plan.unknown_revision_reason',
    );
  }
};

const RevisionHistoryPanel = ({ payload }: { payload: DeadlinePlanPayload }) => {
  // Run the dev-warning pass as a post-render effect so strict-mode-style
  // double-invokes (or vitest act() chains) don't double-warn on the same
  // row before the module-scope Set protects subsequent renders.
  useEffect(() => {
    noteFallbackRevisions(payload.revisionLog);
  }, [payload.revisionLog]);
  if (!payload.revisionSummary.shouldShowPanel) return null;
  const { revisionSummary } = payload;
  return (
    <section class="pels-surface-card budget-redesign-card">
      {/* Eyebrow distinguishes the live-task surface ("Live") from the
          post-finalization history-detail surface ("After this task ran"),
          which share the `.plan-revision-row` markup per `pels-m3-critic`'s
          contract. Anchored to the canonical `.eyebrow` primitive. */}
      <p class="eyebrow">Live</p>
      {/* Summary subline sits OUTSIDE `<details>` so the producer's
          one-line "why?" answer is visible while the panel is collapsed.
          HTML hides every child of `<details>` except `<summary>` when
          closed, so the subline must be a sibling — placing it here keeps
          the at-rest "Recent plan changes — Schedule revised · 15:42 · +1h"
          read without forcing the user to expand. Wraps cleanly at 320 px
          via the `.plan-revision-panel` flex column. */}
      {revisionSummary.text !== null && (
        <p class="plan-revision-panel__summary-subline">{revisionSummary.text}</p>
      )}
      <details class="plan-revision-panel">
        <summary class="plan-revision-panel__summary">
          <span class="plan-card__title">{REVISION_PANEL_TITLE}</span>
          <ExpandMoreIcon class="disclosure-chevron" />
        </summary>
        <ol class="plan-revision-log">
          {payload.revisionLog.map((row) => (
            <li key={`${row.revision}-${row.timeLabel}`} class="plan-revision-row">
              <span class="plan-revision-time">{row.timeLabel}</span>
              <span class="plan-revision-reason">
                {row.isFallback ? REVISION_REASON_FALLBACK_WITH_DETAIL : row.reason}
              </span>
              {/* Suppress the diff chip on fallback rows — the chip would
                  otherwise misattribute the +/−Nh diff to a "Plan refreshed"
                  line that says nothing about why the hours changed. */}
              {row.hourDiff !== null && !row.isFallback && (
                <span
                  class="plan-revision-diff"
                  title={row.hourDiffAriaLabel ?? undefined}
                  aria-label={row.hourDiffAriaLabel ?? undefined}
                >
                  {row.hourDiff}
                </span>
              )}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
};

export const renderDeadlinePlan = (
  surface: HTMLElement,
  loadState: DeadlinePlanLoadState,
): void => {
  render(<DeadlinePlanRoot loadState={loadState} />, surface);
};
