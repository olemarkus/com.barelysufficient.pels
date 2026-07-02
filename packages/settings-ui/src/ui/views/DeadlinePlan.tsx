import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type {
  ActivePlanRevisionLogRow,
  ActivePlanRevisionLogSummary,
} from '../../../../shared-domain/src/activePlanRevisionLog.ts';
import {
  deadlineLabels,
  formatLastSampleValue,
  REVISION_PANEL_TITLE,
  REVISION_REASON_FALLBACK_WITH_DETAIL,
  SMART_TASK_BANNER_RECORD_NOT_FOUND_BODY,
  SMART_TASK_BANNER_RECORD_NOT_FOUND_TITLE,
  SMART_TASK_BANNER_UNAVAILABLE_TITLE,
  NOW_MARKER_WORD,
  SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL,
  SMART_TASK_LOADING_LABEL,
  SMART_TASK_READOUT_SCRUB_HINT,
  SMART_TASK_SCHEDULE_CARD_TITLE,
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
import { MdTextButton } from './materialWebJSX.tsx';
import { ExpandMoreIcon } from './icons.tsx';
import { logSettingsWarn } from '../logging.ts';

// Matches the `.plan-chip--*` CSS variants in
// `packages/settings-ui/public/style.css` (~1340-1374). `alert` was previously
// styled but unreferenced; surfacing it lets the cannot-finish chip use the
// same critical (red) tone as the hero rim instead of a warning (amber) tone
// that contradicted it.
type DeadlinePlanChipTone = 'alert' | 'info' | 'muted' | 'ok' | 'warn';
type DeadlinePlanHourTone = 'cheap' | 'expensive' | 'normal';

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
  tone: DeadlinePlanHourTone;
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
    sectionLabel: string;
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
    metaLine: string;
    // `Cost ≈ X.XX kr` (planned) or `Cost ≈ X.XX kr so far · Y.YY kr planned`
    // (when partial delivery is known). Resolved producer-side from
    // `Σ priceValue × deviceKwh` so the view never re-derives sums or branches
    // on unit. Null when planned cost is unknown (no allocation yet) or the
    // cost unit is missing (Flow / Homey without `priceUnit`).
    costMetaLine: string | null;
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
    // Contiguous planned-hour ranges for the markArea bands; only the first
    // carries the kind-verb label.
    plannedRanges: Array<{ from: number; to: number; label: string | null }>;
    // "Picked N of M hours before the deadline · avg P kr/kWh" trust
    // caption rendered under the chart. Resolved producer-side from the
    // per-hour `priceValue` + `planned` flag via `formatCheapestHoursCaption`
    // so the view never re-derives the averages or branches on price unit.
    // Null when the summary can't be stated honestly (no planned hours, a
    // single-hour window, or a missing price unit).
    cheapestHoursCaption: string | null;
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

export type DeadlinePlanLoadState =
  | { status: 'error'; message: string; onRetry?: () => void; history?: DeadlinePlanHistoryView }
  | { status: 'loading'; history?: DeadlinePlanHistoryView }
  | {
    status: 'pending';
    pending: DeadlinePlanPendingPayload;
    history?: DeadlinePlanHistoryView;
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
  <section class="plan-hero pels-hero" data-tone={payload.hero.tone} aria-labelledby="deadline-plan-hero-title">
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
      <p class="eyebrow plan-hero__section-label" id="deadline-plan-hero-title">{payload.hero.sectionLabel}</p>
      {payload.hero.headline !== null && (
        <h2 class="plan-hero__headline">{payload.hero.headline}</h2>
      )}
      {payload.hero.headlineReason !== null && (
        <div class="plan-hero__subline plan-hero__subline--reason">{payload.hero.headlineReason}</div>
      )}
      <div class="plan-hero__subline">{payload.hero.subline}</div>
      <div class="plan-hero__subline plan-hero__subline--muted">{payload.hero.metaLine}</div>
      {payload.hero.deliveredSoFarLine !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{payload.hero.deliveredSoFarLine}</div>
      )}
      {payload.hero.costMetaLine !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{payload.hero.costMetaLine}</div>
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
  priceCheap: string;
  priceNormal: string;
  priceExpensive: string;
  // Accent series colour: planned-band tint, measured trajectory line, now
  // dot. The band uses it at low opacity so planned ranges read as a wash
  // behind the full-opacity bars.
  accent: string;
  // Muted staircase / guide colour for the planned trajectory ahead.
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
  // Canonical price-tone tokens shared with the history hourly strip — the
  // same cheap/normal/expensive vocabulary on both smart-task surfaces.
  priceCheap: cssVar(element, '--pels-chart-hour-tone-cheap'),
  priceNormal: cssVar(element, '--pels-chart-hour-tone-normal'),
  priceExpensive: cssVar(element, '--pels-chart-hour-tone-expensive'),
  // Semantic role token (not the raw base token) so the chart accent follows
  // any future role remap with the rest of the surface.
  accent: cssVar(element, '--color-role-accent'),
  muted: cssVar(element, '--pels-text-supporting-color'),
  grid: cssVar(element, '--pels-surface-outline'),
  text: cssVar(element, '--text'),
  danger: cssVar(element, '--color-role-danger'),
});

export type ChartTypography = {
  labelFontSize: number;
  axisNameFontSize: number;
  axisNameFontWeight: number;
};

const resolveTypography = (element: HTMLElement): ChartTypography => ({
  labelFontSize: cssNumber(element, '--font-size-xs', 11),
  axisNameFontSize: cssNumber(element, '--font-size-xs', 11),
  axisNameFontWeight: cssNumber(element, '--font-weight-bold', 700),
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
// zero-baselined price axis on the right, tone-coloured price bars (planned
// hours full opacity, unplanned muted), a solid-tint markArea band over the
// planned ranges labeled with the kind verb, a dot markPoint over changed
// hours (replaces the undiscoverable 1px border), and now/deadline markLines
// at their TRUE fractional x-positions. No legend; the ECharts tooltip is
// fully disabled — the pinned readout row below the chart is the only
// tap/scrub surface, so a floating box would double-fire.
//
// NOTE on dash grammar: planned ranges are SOLID tint. Dashed banding is
// reserved for "planned but didn't run" on the history page.
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
  const axisNameStyle = {
    color: palette.text,
    fontSize: typography.axisNameFontSize,
    fontWeight: typography.axisNameFontWeight,
    align: 'center' as const,
  };
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    grid: { left: 8, right: 56, top: 24, bottom: 24, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: true,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: typography.labelFontSize,
        interval: (index: number) => (
          index === timeline.nowIndex || index === hourCount - 1 || index % showLabelEvery === 0
        ),
        formatter: (value: string, index: number) => (
          index === timeline.nowIndex ? NOW_MARKER_WORD : value
        ),
      },
    },
    yAxis: {
      type: 'value',
      position: 'right',
      name: payload.priceUnitLabel,
      nameLocation: 'middle',
      nameGap: 44,
      nameRotate: 0,
      nameTextStyle: axisNameStyle,
      min: priceAxisMin,
      max: priceMax,
      // Force a single tick at min / max so the axis labels stay readable —
      // without this, kr/kWh values can fall into ECharts' default 5-tick
      // layout and overlap at 320 px.
      interval: Math.max(0.01, priceMax - priceAxisMin),
      splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.text,
        fontSize: typography.labelFontSize,
        // One-decimal precision matches the Budget chart's price axis so
        // users see the same number format on both surfaces. The readout
        // retains two-decimal precision via `formatPrice` in `deadlinePlan.ts`.
        formatter: (value: number) => {
          if (priceAxisMin < 0 && Math.abs(value - priceAxisMin) < 0.001) return priceAxisMin.toFixed(1);
          if (Math.abs(value - priceMax) < 0.001) return priceMax.toFixed(1);
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
        data: timeline.hours.map((hour) => ({
          value: hour.priceValue,
          itemStyle: {
            color: hour.tone === 'cheap'
              ? palette.priceCheap
              : hour.tone === 'expensive'
                ? palette.priceExpensive
                : palette.priceNormal,
            opacity: hour.planned ? 1 : 0.4,
            borderRadius: [3, 3, 0, 0],
          },
        })),
        // Selected-hour highlight, driven imperatively via
        // `dispatchAction({type:'highlight'})` from the scrub handler. The
        // border alone carries the selection; opacity is deliberately NOT
        // overridden so the selected bar keeps its planned/unplanned channel
        // (ECharts emphasis inherits unspecified itemStyle props per-datum).
        emphasis: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
        markArea: {
          silent: true,
          itemStyle: { color: palette.accent, opacity: 0.12 },
          label: {
            show: true,
            color: palette.accent,
            fontSize: typography.labelFontSize,
            position: 'insideTop' as const,
          },
          data: timeline.plannedRanges.map((range) => ([
            { name: range.label ?? '', xAxis: range.from },
            { xAxis: range.to },
          ])),
        },
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
        lineStyle: { color: palette.muted, width: 1.5 },
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
export const PlanInputsCard = ({ payload }: { payload: DeadlinePlanPayload }) => {
  const {
    perUnitRateLabel,
    perUnitRateNote,
    maxPowerLabel,
    maxPowerNote,
    extraPermissionsValue,
    provenanceRows,
  } = payload.planInputs;
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
      <ScheduleQuestionCards payload={loadState.payload} />
      <PlanInputsCard payload={loadState.payload} />
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
