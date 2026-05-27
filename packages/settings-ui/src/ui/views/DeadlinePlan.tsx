import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type { DeferredObjectiveActivePlanRevisionReason } from '../../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { ActivePlanRevisionLogRow } from '../../../../shared-domain/src/activePlanRevisionLog.ts';
import {
  deadlineLabels,
  formatLastSampleValue,
  SMART_TASK_BANNER_RECORD_NOT_FOUND_BODY,
  SMART_TASK_BANNER_RECORD_NOT_FOUND_TITLE,
  SMART_TASK_BANNER_UNAVAILABLE_TITLE,
  SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL,
  SMART_TASK_LOADING_LABEL,
  type DeadlineCannotMeetRecourse,
  type DeadlineLabels,
  type DeadlinePlanUnavailableReason,
  type KwhPerUnitProvenanceRow,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from '../echartsRegistry.ts';
import { attachTabShownResize } from '../chartVisibilityResize.ts';
import { formatAcceptedAt } from '../deadlinePlanFormatters.ts';
import type { DeadlinePlanHistoryView } from '../deadlinePlanHistoryFetch.ts';
import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { DeadlinePlanHistoryDetail } from './DeadlinePlanHistoryDetail.tsx';
import { DeadlinesHistoryListRoot } from './DeadlinesHistoryList.tsx';
import { MdTextButton } from './materialWebJSX.tsx';
import { ExpandMoreIcon } from './icons.tsx';

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
  time: string;
  price: string;
  priceValue: number;
  tone: DeadlinePlanHourTone;
  planned: boolean;
  changed: boolean;
  // Populated on changed hours from the latest revision's reason; null otherwise.
  revisionReason: DeferredObjectiveActivePlanRevisionReason | null;
  usage: {
    backgroundKwh: number;
    originalDeviceKwh: number;
    deviceKwh: number;
    actualDeviceKwh: number | null;
  };
  progress: number;
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
    progressFloor: number;
    progressCeilingValue: number;
    progressCeilingLabel: string;
    deadlineLabel: string;
    hours: DeadlinePlanHour[];
  };
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
  // `buildActivePlanRevisionLog`. Empty array suppresses the entire panel —
  // happens on the first-revision case (head row alone is redundant with the
  // already-rendered hero/timeline) and on legacy persisted plans without a
  // `history` field. Sharing the row shape with the post-finalization log
  // (`.plan-revision-row` CSS) keeps the visual binding identical across
  // both surfaces.
  revisionLog: ActivePlanRevisionLogRow[];
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
  | { status: 'pending'; pending: DeadlinePlanPendingPayload; history?: DeadlinePlanHistoryView }
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
  | { status: 'ready'; payload: DeadlinePlanPayload; history?: DeadlinePlanHistoryView }
  | {
    // Detail view for a finalized plan in history. The page lands on the
    // History tab and shows the entry's recorded plan snapshots instead of
    // the live planner output.
    status: 'history-detail';
    entry: DeferredObjectivePlanHistoryEntry;
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
      <p class="eyebrow plan-hero__section-label" id="deadline-plan-title">{payload.hero.sectionLabel}</p>
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
            class="pels-button"
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
  background: string;
  device: string;
  actualDevice: string;
  progress: string;
  grid: string;
  text: string;
  muted: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
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
  priceCheap: cssVar(element, '--pels-status-good-border'),
  priceNormal: cssVar(element, '--pels-surface-container-high'),
  priceExpensive: cssVar(element, '--color-base-warning-default'),
  background: cssVar(element, '--pels-text-supporting-color'),
  device: cssVar(element, '--color-base-accent-default'),
  actualDevice: cssVar(element, '--color-role-good'),
  progress: cssVar(element, '--color-base-info-default'),
  grid: cssVar(element, '--pels-surface-outline'),
  text: cssVar(element, '--text'),
  muted: cssVar(element, '--pels-text-supporting-color'),
  tooltipBackground: cssVar(element, '--color-overlay-toast'),
  tooltipText: cssVar(element, '--color-semantic-text-primary'),
  tooltipBorder: cssVar(element, '--color-border-medium'),
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

const resolveChartSize = (element: HTMLElement): { height: number; width: number } => {
  const width = element.clientWidth > 0 ? element.clientWidth : (element.parentElement?.clientWidth ?? 390);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  return {
    width: width > 0 ? width : Math.min(480, viewportWidth || 390),
    // Default height matches `.deadline-horizon-chart` in style.css (240 px)
    // so a cold-mount inside a hidden panel sizes the chart consistently with
    // the post-resize value.
    height: element.clientHeight > 0 ? element.clientHeight : 240,
  };
};

const formatProgressValue = (value: number, unit: DeadlineLabels['targetUnit']): string => (
  unit === '°C' ? `${value.toFixed(1)} °C` : `${Math.round(value)}%`
);

const buildTooltip = (payload: DeadlinePlanPayload, rawParams: unknown): string => {
  const params = Array.isArray(rawParams) ? rawParams : [rawParams];
  const first = params.find((item): item is { dataIndex: number } => (
    Boolean(item) && typeof item === 'object' && Number.isInteger((item as { dataIndex?: unknown }).dataIndex)
  ));
  const hour = first ? payload.timeline.hours[first.dataIndex] : null;
  if (!hour) return '';
  const labels = payload.labels;
  // Only the not-planned state needs its own line — the planned case is
  // already conveyed by the device-series line ("Heating 2.0 kWh"). Dropping
  // the planner-noun "Plan " prefix here too (TODO 1062).
  const idleLine = hour.planned ? null : labels.planTooltipIdle;
  const originalLine = hour.changed
    ? `${labels.originalDeviceSeriesName} ${hour.usage.originalDeviceKwh.toFixed(1)} kWh`
    : null;
  const actualLine = hour.usage.actualDeviceKwh !== null
    ? `${labels.actualDeviceSeriesName} ${hour.usage.actualDeviceKwh.toFixed(1)} kWh`
    : null;
  const revisionLine = hour.changed && hour.revisionReason !== null
    ? (labels.revisionReasonTooltipLine[hour.revisionReason] ?? null)
    : null;
  return [
    `<strong>${encodeHtml(hour.time)}</strong>`,
    `Price ${encodeHtml(hour.price)} ${encodeHtml(payload.priceUnitLabel)}`,
    `${encodeHtml(labels.backgroundSeriesName)} ${hour.usage.backgroundKwh.toFixed(1)} kWh`,
    ...(originalLine ? [encodeHtml(originalLine)] : []),
    `${encodeHtml(labels.deviceSeriesName)} ${hour.usage.deviceKwh.toFixed(1)} kWh`,
    ...(actualLine ? [encodeHtml(actualLine)] : []),
    ...(idleLine ? [encodeHtml(idleLine)] : []),
    `${encodeHtml(labels.progressSeriesName)} ${formatProgressValue(hour.progress, labels.targetUnit)}`,
    ...(revisionLine ? [encodeHtml(revisionLine)] : []),
  ].join('<br>');
};

// Two-grid ECharts layout inside a 240 px container. Top: price, Bottom: load + progress overlay.
// The 44 px top reserves room for a two-line legend (`width: '100%'`) — with
// up to 5 long localized series names at 320–480 px the legend wraps, and a
// single-line `top: 28` left no room above the price grid.
const PRICE_GRID_TOP = 44;
const PRICE_GRID_HEIGHT = 56;
const LOAD_GRID_TOP = 126;
const LOAD_GRID_HEIGHT = 84;
const GRID_LEFT = 36;
const GRID_RIGHT = 56;

// Pinned bar width + category gap shared by every bar series across both
// xAxis grids (`xAxisIndex 0` = price, `xAxisIndex 1` = load). ECharts auto-
// sizes bars per grid: the price grid has 1 bar series while the load grid
// has 2–4 (background + device + optional original-overlay + optional actual
// line), and without explicit pins the auto-sizer picks different widths and
// off-centres the bars relative to the category. Pinning both values makes
// bar centres parity-aligned at every viewport from 320–480 px, which the
// `bar-centre parity` E2E spec asserts. `barWidth` (not `barMaxWidth`) is
// required: `barMaxWidth` is an upper bound that the auto-sizer still varies
// per grid, defeating the alignment goal.
const BAR_WIDTH = 14;
const BAR_CATEGORY_GAP = '20%';

export const buildChartOption = (
  payload: DeadlinePlanPayload,
  palette: DeadlineChartPalette,
  typography: ChartTypography,
): EChartsOption => {
  const hourCount = payload.timeline.hours.length;
  const labels = payload.timeline.hours.map((hour) => hour.time);
  const showLabelEvery = hourCount > 10 ? 3 : 2;
  // Use the natural max of the (already scaled) display values and keep the
  // price axis anchored at zero for normal non-negative prices. Nord Pool can
  // go negative; in that case the lower bound follows the data so those hours
  // remain visible instead of being flattened into the zero line.
  const priceValues = payload.timeline.hours.map((hour) => hour.priceValue);
  const rawPriceMin = priceValues.length ? Math.min(...priceValues) : 0;
  const rawPriceMax = priceValues.length ? Math.max(...priceValues) : 0;
  const priceAxisMin = rawPriceMin < 0 ? rawPriceMin : 0;
  const priceMax = rawPriceMax > 0 ? rawPriceMax : (priceAxisMin < 0 ? 0 : 1);
  const stackedMax = Math.max(0.5, ...payload.timeline.hours.map((hour) => (
    Math.max(
      hour.usage.backgroundKwh + Math.max(hour.usage.originalDeviceKwh, hour.usage.deviceKwh),
      hour.usage.actualDeviceKwh ?? 0,
    )
  )));
  const originalSeriesName = payload.labels.originalDeviceSeriesName;
  const hasActualDeviceSeries = payload.timeline.hours.some((hour) => hour.usage.actualDeviceKwh !== null);
  // Suppress the original-series legend and overlay bars when the plan has never
  // been revised: every hour's originalDeviceKwh equals deviceKwh, so rendering
  // both series produces duplicate legend entries with no informational gain.
  // Matches the suppression logic in DeadlinePlanHistoryDetail.
  const hasOriginalSeries = payload.timeline.hours.some(
    (hour) => Math.abs(hour.usage.originalDeviceKwh - hour.usage.deviceKwh) > 0.001,
  );

  const axisBase = {
    type: 'category' as const,
    data: labels,
    boundaryGap: true,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: palette.grid } },
    axisLabel: {
      color: palette.muted,
      fontSize: typography.labelFontSize,
      interval: (index: number) => index === 0 || index === hourCount - 1 || index % showLabelEvery === 0,
      formatter: (value: string, index: number) => {
        if (index === 0) return `Now\n${value}`;
        if (index === hourCount - 1) return `${payload.timeline.deadlineLabel}\n${value}`;
        return value;
      },
    },
  };
  const valueAxisBase = {
    type: 'value' as const,
    splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: palette.text, fontSize: typography.labelFontSize },
  };
  const axisNameStyle = {
    color: palette.text,
    fontSize: typography.axisNameFontSize,
    fontWeight: typography.axisNameFontWeight,
    align: 'center' as const,
  };
  const showCeilingOnly = (max: number, label: string) => (value: number) => (
    Math.abs(value - max) < 0.001 ? label : ''
  );
  const nowMarkLine = {
    silent: true,
    symbol: 'none' as const,
    lineStyle: { color: palette.muted, type: 'dashed' as const, width: 1 },
    label: { show: false },
    data: [{ xAxis: 0 }],
  };

  // Shared builder for the progress axis. The load grid uses it for the
  // visible left axis (`palette.progress` colour) and the price grid uses
  // it for a transparent phantom that reserves identical layout width —
  // see the bar-alignment comment near the yAxis array (TODO 628). Keeping
  // a single builder ensures future tweaks (ticks, ranges, formatter) stay
  // mirrored across the two grids.
  const buildProgressAxis = (gridIndex: 0 | 1, color: string) => ({
    ...valueAxisBase,
    gridIndex,
    position: 'left' as const,
    name: payload.labels.targetUnit,
    nameLocation: 'middle' as const,
    nameGap: GRID_LEFT - 12,
    nameRotate: 0,
    nameTextStyle: { ...axisNameStyle, color },
    min: payload.timeline.progressFloor,
    max: payload.timeline.progressCeilingValue,
    interval: Math.max(1, payload.timeline.progressCeilingValue - payload.timeline.progressFloor),
    splitLine: { show: false },
    axisLabel: {
      ...valueAxisBase.axisLabel,
      color,
      formatter: showCeilingOnly(payload.timeline.progressCeilingValue, payload.timeline.progressCeilingLabel),
    },
  });

  return {
    animation: false,
    backgroundColor: 'transparent',
    color: [palette.background, palette.device, palette.actualDevice, palette.progress],
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    legend: {
      top: 0,
      left: 0,
      // Let the legend wrap onto a second row instead of truncating to
      // "Background usa…" / "Original Heatin…" / "Measured Heati…" when 4–5
      // long localized series names overflow the 320–480 px chart width.
      // `PRICE_GRID_TOP` (44) and the container `.deadline-horizon-chart`
      // height token reserve enough vertical room for a two-line legend.
      width: '100%',
      // Explicit `itemStyle` per entry: the original-plan series renders its
      // bars as `transparent` fill + colored border, which would otherwise
      // produce an invisible legend swatch. Pin each legend swatch to the
      // colour the user actually sees in the rendered series.
      data: [
        { name: payload.labels.backgroundSeriesName, itemStyle: { color: palette.background } },
        { name: payload.labels.deviceSeriesName, itemStyle: { color: palette.device } },
        ...(hasOriginalSeries
          ? [{
              name: originalSeriesName,
              itemStyle: {
                color: 'transparent',
                borderColor: palette.device,
                borderWidth: 2,
                borderType: 'dashed' as const,
              },
            }]
          : []),
        ...(hasActualDeviceSeries
          ? [{ name: payload.labels.actualDeviceSeriesName, itemStyle: { color: palette.actualDevice } }]
          : []),
        { name: payload.labels.progressSeriesName, itemStyle: { color: palette.progress } },
      ],
      itemWidth: 12,
      itemHeight: 8,
      icon: 'roundRect',
      textStyle: { color: palette.muted, fontSize: typography.labelFontSize },
      inactiveColor: palette.grid,
    },
    grid: [
      // `containLabel: true` makes ECharts auto-reserve enough horizontal
      // space INSIDE the `[left, right]` box for both axes' labels + names.
      // The result is that both grids share the same effective plot area
      // (since they reserve identical insets), and the bars at the same
      // `dataIndex` line up horizontally between the two grids (TODO 628).
      // Without it the price grid (single right axis) and load grid (left
      // progress axis + right kWh axis) end up with different plot widths
      // and bars drift apart.
      { top: PRICE_GRID_TOP, left: GRID_LEFT, right: GRID_RIGHT, height: PRICE_GRID_HEIGHT, containLabel: true },
      { top: LOAD_GRID_TOP, left: GRID_LEFT, right: GRID_RIGHT, height: LOAD_GRID_HEIGHT, containLabel: true },
    ],
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText },
      formatter: (params: unknown) => buildTooltip(payload, params),
    },
    xAxis: [
      { ...axisBase, gridIndex: 0, axisLabel: { show: false } },
      { ...axisBase, gridIndex: 1 },
    ],
    yAxis: [
      {
        ...valueAxisBase,
        gridIndex: 0,
        position: 'right',
        name: payload.priceUnitLabel,
        nameLocation: 'middle',
        nameGap: GRID_RIGHT - 12,
        nameRotate: 0,
        nameTextStyle: axisNameStyle,
        min: priceAxisMin,
        max: priceMax,
        // Force a single tick at min / max so the axis labels stay readable in
        // the narrow 56-px price grid — without this, kr/kWh values can fall
        // into ECharts' default 5-tick layout and overlap.
        interval: Math.max(0.01, priceMax - priceAxisMin),
        axisLabel: {
          ...valueAxisBase.axisLabel,
          // One-decimal precision matches the Budget chart's price axis
          // (`budgetRedesignChart.ts:400`) so users see the same number
          // format on both surfaces. Tooltip retains two-decimal precision
          // via `formatPrice` in `deadlinePlan.ts`.
          formatter: (value: number) => {
            if (priceAxisMin < 0 && Math.abs(value - priceAxisMin) < 0.001) return priceAxisMin.toFixed(1);
            if (Math.abs(value - priceMax) < 0.001) return priceMax.toFixed(1);
            return '';
          },
        },
      },
      // Phantom left axis on the price grid — invisible to the user but
      // mirrors the load grid's progress axis so ECharts reserves the same
      // plot-area inset on both grids. Without it, the load grid's left
      // axis pushes its plot area ~20 px to the right (TODO 628) and the
      // bars at matching `dataIndex` end up off-centre between the two
      // grids. The axis label text is the same shape as the load grid's
      // ceiling label so ECharts measures the same text width;
      // `color: 'transparent'` paints it invisibly while the glyphs still
      // occupy layout space. Sharing the builder with the load grid keeps
      // the two axes in lock-step under future tweaks.
      buildProgressAxis(0, 'transparent'),
      {
        ...valueAxisBase,
        gridIndex: 1,
        position: 'right',
        name: 'kWh',
        nameLocation: 'middle',
        nameGap: GRID_RIGHT - 12,
        nameRotate: 0,
        nameTextStyle: axisNameStyle,
        min: 0,
        max: stackedMax,
        interval: stackedMax,
        axisLabel: {
          ...valueAxisBase.axisLabel,
          formatter: showCeilingOnly(stackedMax, stackedMax.toFixed(1)),
        },
      },
      buildProgressAxis(1, palette.progress),
    ],
    series: [
      {
        name: 'Price',
        type: 'bar',
        xAxisIndex: 0,
        yAxisIndex: 0,
        barWidth: BAR_WIDTH,
        barCategoryGap: BAR_CATEGORY_GAP,
        barMinHeight: 3,
        markLine: nowMarkLine,
        data: payload.timeline.hours.map((hour) => ({
          value: hour.priceValue,
          itemStyle: {
            color: hour.tone === 'cheap'
              ? palette.priceCheap
              : hour.tone === 'expensive'
                ? palette.priceExpensive
                : palette.priceNormal,
            borderRadius: [5, 5, 2, 2],
          },
        })),
      },
      {
        name: payload.labels.backgroundSeriesName,
        type: 'bar',
        stack: 'load',
        xAxisIndex: 1,
        // kWh axis moved from yAxis[1] to yAxis[2] after the price-grid
        // phantom axis was inserted at yAxis[1] (see the phantom-axis comment
        // above the yAxis array). All load-grid bar/line series share this
        // shifted index.
        yAxisIndex: 2,
        barWidth: BAR_WIDTH,
        barCategoryGap: BAR_CATEGORY_GAP,
        markLine: nowMarkLine,
        data: payload.timeline.hours.map((hour) => hour.usage.backgroundKwh),
        itemStyle: { color: palette.background, borderRadius: [0, 0, 0, 0] },
      },
      {
        name: payload.labels.deviceSeriesName,
        type: 'bar',
        stack: 'load',
        xAxisIndex: 1,
        yAxisIndex: 2,
        barWidth: BAR_WIDTH,
        barCategoryGap: BAR_CATEGORY_GAP,
        data: payload.timeline.hours.map((hour) => ({
          value: hour.usage.deviceKwh,
          itemStyle: {
            color: palette.device,
            opacity: hour.planned ? 1 : 0.45,
            borderColor: hour.changed ? palette.tooltipText : palette.device,
            borderWidth: hour.changed ? 1 : 0,
            borderRadius: [3, 3, 0, 0],
          },
        })),
      },
      ...(hasOriginalSeries ? [
        {
          name: payload.labels.backgroundSeriesName,
          type: 'bar' as const,
          stack: 'original-load',
          xAxisIndex: 1,
          yAxisIndex: 2,
          barWidth: BAR_WIDTH,
          barCategoryGap: BAR_CATEGORY_GAP,
          barGap: '-100%',
          silent: true,
          tooltip: { show: false },
          itemStyle: { color: 'transparent', borderColor: 'transparent' },
          emphasis: { disabled: true },
          data: payload.timeline.hours.map((hour) => hour.usage.backgroundKwh),
        },
        {
          name: originalSeriesName,
          type: 'bar' as const,
          stack: 'original-load',
          xAxisIndex: 1,
          yAxisIndex: 2,
          barWidth: BAR_WIDTH,
          barCategoryGap: BAR_CATEGORY_GAP,
          barGap: '-100%',
          itemStyle: { color: 'transparent', borderColor: palette.device, borderWidth: 2 },
          data: payload.timeline.hours.map((hour) => ({
            value: hour.usage.originalDeviceKwh,
            itemStyle: {
              color: 'transparent',
              borderColor: hour.usage.originalDeviceKwh > 0 ? palette.device : 'transparent',
              borderWidth: hour.usage.originalDeviceKwh > 0 ? 2 : 0,
              borderType: hour.changed ? 'dashed' as const : 'solid' as const,
              borderRadius: [3, 3, 0, 0],
            },
          })),
        },
      ] : []),
      ...(hasActualDeviceSeries ? [{
        name: payload.labels.actualDeviceSeriesName,
        type: 'line' as const,
        xAxisIndex: 1,
        yAxisIndex: 2,
        symbol: 'circle',
        symbolSize: 7,
        connectNulls: false,
        lineStyle: { color: palette.actualDevice, width: 2, type: 'dotted' as const },
        itemStyle: { color: palette.actualDevice },
        data: payload.timeline.hours.map((hour) => hour.usage.actualDeviceKwh),
      }] : []),
      {
        name: payload.labels.progressSeriesName,
        type: 'line',
        step: 'end',
        xAxisIndex: 1,
        // Progress axis sits at yAxis[3] after the price-grid phantom axis was
        // inserted at yAxis[1] to match the load grid's left-axis inset.
        yAxisIndex: 3,
        symbol: 'none',
        lineStyle: { color: palette.progress, width: 2 },
        areaStyle: { color: palette.progress, opacity: 0.12 },
        data: payload.timeline.hours.map((hour) => hour.progress),
      },
    ] satisfies SeriesOption[],
  };
};

// Writes per-grid bar x-centres to a data attribute on the chart container so
// the bar-centre parity E2E spec (TODO 628) can verify alignment without
// poking at SVG paths or fragile heuristics. The attribute carries one entry
// per hour for each xAxis: `{"price":[x0,…], "load":[x0,…]}`. Test-only path;
// removing it would only weaken the regression suite.
const writeBarCentresForTest = (
  container: HTMLElement,
  chart: EChartsType,
  hourCount: number,
): void => {
  const collect = (xAxisIndex: number): number[] => {
    const centres: number[] = [];
    for (let i = 0; i < hourCount; i += 1) {
      // `convertToPixel` on a category axis returns a single x-pixel for the
      // category index. Pass `i` as the data index. Some echarts versions
      // return `[x, y]` instead of `x`; handle both shapes defensively so the
      // attribute is populated either way.
      const pixel = chart.convertToPixel({ xAxisIndex }, i);
      const x = Array.isArray(pixel) ? pixel[0] : pixel;
      if (Number.isFinite(x)) centres.push(Number((x as number).toFixed(2)));
    }
    return centres;
  };
  container.setAttribute('data-test-bar-centres', JSON.stringify({
    price: collect(0),
    load: collect(1),
  }));
};

const HorizonChart = ({ payload }: { payload: DeadlinePlanPayload }) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return undefined;
    const chart = initEcharts(container, undefined, {
      renderer: 'svg',
      ...resolveChartSize(container),
    });
    chartInstanceRef.current = chart;
    chart.setOption(
      buildChartOption(payload, resolvePalette(container), resolveTypography(container)),
      { notMerge: true },
    );
    writeBarCentresForTest(container, chart, payload.timeline.hours.length);

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        chart.resize(resolveChartSize(container));
        writeBarCentresForTest(container, chart, payload.timeline.hours.length);
      })
      : null;
    resizeObserver?.observe(container);
    // Cold-mount path: the chart may be initialized while its panel is still
    // `display:none`, so `clientWidth` was the 480 px fallback. Resize once on
    // the next frame so the SVG settles to the real visible width before the
    // user sees it, and re-resize whenever the chart's tab is shown again.
    const detachTabShown = attachTabShownResize({ container, chart, resolveSize: resolveChartSize });

    return () => {
      resizeObserver?.disconnect();
      detachTabShown();
      chart.dispose();
      if (chartInstanceRef.current === chart) chartInstanceRef.current = null;
    };
  }, [payload]);

  return <div ref={chartRef} class="deadline-horizon-chart" role="img" aria-label={payload.timeline.ariaLabel} />;
};

const HorizonCard = ({ payload }: { payload: DeadlinePlanPayload }) => (
  <section class="pels-surface-card budget-redesign-card deadline-horizon-card" aria-labelledby="deadline-horizon-title">
    <div class="budget-card-header">
      <h2 class="plan-card__title" id="deadline-horizon-title">Price horizon</h2>
    </div>
    <HorizonChart payload={payload} />
  </section>
);

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
// without also mounting `HorizonChart` (whose ECharts `initEcharts` call hits
// real ECharts subpaths the JSDOM-aliased shim doesn't fully cover). The
// production render path still routes through `DeadlinePlanRoot` below.
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
            class="pels-button"
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
const PriorRunsHistory = ({ history }: { history: DeadlinePlanHistoryView | undefined }) => {
  if (!history || history.entries.length === 0) return null;
  return (
    <DeadlinesHistoryListRoot
      state={{ status: 'ready', entries: history.entries, timeZone: history.timeZone }}
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
      <HorizonCard payload={loadState.payload} />
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
const RevisionHistoryPanel = ({ payload }: { payload: DeadlinePlanPayload }) => {
  if (payload.revisionLog.length < 2) return null;
  return (
    <section class="pels-surface-card budget-redesign-card">
      <details class="plan-revision-panel">
        <summary class="plan-revision-panel__summary">
          <span class="plan-card__title">Recent plan changes</span>
          <small class="section-hint">{`${payload.revisionLog.length} revisions`}</small>
          <ExpandMoreIcon class="disclosure-chevron" />
        </summary>
        <ol class="plan-revision-log">
          {payload.revisionLog.map((row) => (
            <li key={`${row.revision}-${row.timeLabel}`} class="plan-revision-row">
              <span class="plan-revision-time">{row.timeLabel}</span>
              <span class="plan-revision-reason">{row.reason}</span>
              {row.hourDiff !== null && (
                <span class="plan-revision-diff">{row.hourDiff}</span>
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
