import type { ComponentChild } from 'preact';
import { computeProjectedHourEnergyKWh, isProjectedOverHardCap } from '../../../../shared-domain/src/hourEnergyProjection.ts';
import {
  buildDecisionSentence as buildSharedDecisionSentence,
  computeEnergyBarScaleKWh,
  formatAboveSafePaceSubline,
  formatCheapestUpcomingHour,
  formatEnergyMeterMarkerLabels,
  formatEnergyUsedOfBudgetParts,
  formatFreshnessChip,
  formatHeroHeadline,
  formatPowerMeterMarkerLabels,
  formatProjectedEnergySubline,
  formatSafePaceSubline,
  type HeroHeadline,
  type HeroMeterMarkerLabels,
  type PlanHeroMetaInput,
} from '../../../../shared-domain/src/planHeroSummary.ts';
import {
  HERO_INFO_TOOLTIP_TEXT,
  formatHardCapEnergyTooltip,
  formatHardCapTooltip,
  formatSafePaceComposition,
  formatSafePaceTooltip,
  resolveSafePaceSourceText,
} from '../../../../shared-domain/src/planHeroTooltips.ts';
import { resolveDisplayPlanDevices } from '../planLiveData.ts';
import { PLAN_REASON_CODES } from '../../../../shared-domain/src/planReasonSemantics.ts';
import type { PlanDeviceSnapshot, PlanMetaSnapshot, PlanSnapshot } from '../planTypes.ts';
import type {
  SettingsUiPowerStatus,
  SettingsUiPricesPayload,
} from '../../../../contracts/src/settingsUiApi.ts';
import { resolveCostDisplayFromCombinedPrices, resolvePriceUnitLabel } from '../priceUnit.ts';
import { normalizeCombinedPrices } from '../combinedPrices.ts';
import {
  formatSolarNowSubline,
  resolveSolarNow,
  type SolarNowInput,
} from '../../../../shared-domain/src/solar/solarNow.ts';
import { MdIconButton } from './materialWebJSX.tsx';

type FreshnessState = NonNullable<SettingsUiPowerStatus['powerFreshnessState']>;
type HeroStatus = 'on-track' | 'above-safe-pace' | 'projected-over-budget' | 'over-hard-cap' | 'dry-run' | 'no-data';

const HERO_STATUS_LABEL: Partial<Record<HeroStatus, string>> = {
  'above-safe-pace': 'Above safe pace',
  'projected-over-budget': 'Above budget',
  'over-hard-cap': 'Above hard cap',
  'dry-run': 'Simulation mode',
  'no-data': 'No data',
};

const HERO_STATUS_CHIP_TONE: Record<HeroStatus, string> = {
  'on-track': 'muted',
  'above-safe-pace': 'warn',
  'projected-over-budget': 'warn',
  'over-hard-cap': 'alert',
  'dry-run': 'warn',
  'no-data': 'alert',
};

const HERO_STATUS_DATA_TONE: Record<HeroStatus, string> = {
  'on-track': 'ok',
  'above-safe-pace': 'warn',
  'projected-over-budget': 'warn',
  'over-hard-cap': 'alert',
  'dry-run': 'warn',
  'no-data': 'alert',
};

const resolveFreshnessState = (
  power: SettingsUiPowerStatus | null | undefined,
  meta: PlanMetaSnapshot,
): FreshnessState | undefined => {
  const fromPower = power?.powerFreshnessState;
  if (fromPower) return fromPower;
  return meta.powerFreshnessState;
};

const resolveHeroStatus = (
  headline: HeroHeadline,
  devices: PlanDeviceSnapshot[],
  freshnessState: FreshnessState | undefined,
  dryRun: boolean,
  projectionTone: ProjectionTone | null,
  projectedOverHardCap: boolean,
): HeroStatus => {
  if (freshnessState === 'stale_fail_closed') return 'no-data';
  // "Above hard cap" is a trajectory judgement: projected this-hour energy
  // exceeds the cap's hourly kWh. Instantaneous kW above the cap is NOT a
  // breach — the cap is an hourly-average tariff-step ceiling, and safe pace
  // legitimately exceeds it late in an under-used hour (see
  // `notes/ui-terminology.md` § "Hard cap is an hourly ceiling"). Keyed on the
  // standalone flag, not `projectionTone === 'critical'`: the tone only exists
  // when the energy bar does (`hourBudgetKWh > 0`), and a zero-allocation
  // daily-budget hour must not silence the app's only red alarm.
  if (projectedOverHardCap) return 'over-hard-cap';
  // Surface the simulation-mode chip whenever there is anything the decision
  // sentence has to phrase hypothetically — that includes devices stuck `held`
  // from before simulation was enabled.
  if (dryRun && devices.some((d) => isWouldLimitDevice(d) || isLimitedDevice(d))) return 'dry-run';
  if (headline.overSoftLimit) return 'above-safe-pace';
  if (projectionTone === 'warning') return 'projected-over-budget';
  return 'on-track';
};

const isLimitedDevice = (device: PlanDeviceSnapshot): boolean => (
  device.stateKind === 'held' || device.plannedState === 'shed'
);

const isResumingDevice = (device: PlanDeviceSnapshot): boolean => (
  device.stateKind === 'resuming' || Boolean(device.binaryCommandPending && device.currentState === 'off')
);

// A managed device PELS has NOT finished easing off: it has Power-limit control
// (`controllable`) and is either still running (`stateKind ===
// 'active'`) OR has been selected for shedding but has not yet settled.
// `resolvePlanStateKind` marks a device `held` the instant the plan says shed,
// so an `active`-only check would miss a managed load that is still drawing and
// wrongly claim the cascade is done mid-shed. For a pending shed we judge
// "settled" by draw (a temperature device stays `currentState: 'on'` after PELS
// only lowers its setpoint, so on-like state alone would never let the cascade
// read exhausted for heaters). When none remain while over the hard cap, the
// managed shed cascade is genuinely exhausted — the decision sentence then stops
// promising further mitigation. Devices with Power-limit control turned off
// (`controllable === false`) are excluded by construction.
//
// There is no longer an "unmeasured" fallback to on-like state: the plan read
// model always carries a resolved draw, and every managed device is metered
// (verified across a 124-device fleet), so a still-running managed load keeps the
// cascade open on its own reading rather than on a separate state check.
const isPendingShedStillRunning = (device: PlanDeviceSnapshot): boolean => (
  (device.currentDrawKw ?? 0) > 0
);
const isSheddableManagedRunningDevice = (device: PlanDeviceSnapshot): boolean => (
  device.controllable && (
    device.stateKind === 'active'
    || (device.plannedState === 'shed' && isPendingShedStillRunning(device))
  )
);

// A device that is breaching the cap with Power-limit control turned off: it
// has control off (`controllable === false` → reason `capacityControlOff`) AND
// is actually drawing power (`currentDrawKw > 0`). The measured-draw gate
// matters — a parked opt-out device sitting at 0 W is not the source of the
// breach, so the "remaining draw is from it" copy must not fire on it.
const isBreachingControlOffDevice = (device: PlanDeviceSnapshot): boolean => (
  device.reason?.code === PLAN_REASON_CODES.capacityControlOff
  && (device.currentDrawKw ?? 0) > 0
);

// In simulation mode the planner outputs `plannedState === 'shed'` but never
// actually flips device state. Identify devices the planner *would* limit — i.e.
// planner says shed and the device is not already in the held state.
const isWouldLimitDevice = (device: PlanDeviceSnapshot): boolean => (
  device.plannedState === 'shed' && device.stateKind !== 'held'
);

// Decision sentence priority order. Voice + wording live in shared-domain
// (`planHeroSummary.buildDecisionSentence`) so that a runtime log breadcrumb,
// if one is ever added, quotes the UI's phrasing instead of restating it (see
// `feedback_ui_text_shared_with_logs.md`); nothing in the runtime imports that
// module today. The ladder is documented in `notes/overview-hero-spec.md`
// § "Decision sentence".
//
// This adapter narrows the local view-model (devices array, projection tone)
// to the counts and booleans the shared helper takes — keeping the helper
// independent of UI types.
const buildDecisionSentence = ({
  devices,
  freshnessState,
  dryRun,
  projectedOverHardCap,
  projectionTone,
  safePaceKw,
}: {
  devices: PlanDeviceSnapshot[];
  freshnessState: FreshnessState | undefined;
  dryRun: boolean;
  projectedOverHardCap: boolean;
  projectionTone: ProjectionTone | null;
  safePaceKw: number | null;
}): { text: string; positive: boolean } => {
  const limited = devices.filter(isLimitedDevice);
  return buildSharedDecisionSentence({
    limitedCount: limited.length,
    resumingCount: devices.filter(isResumingDevice).length,
    freshness: freshnessState,
    dryRun,
    projectedOverHardCap,
    projectedOverBudget: projectedOverHardCap
      || projectionTone === 'warning' || projectionTone === 'critical',
    safePaceKw,
    deferredObjectiveAvoidCount: limited.filter((d) => d.reason?.code === PLAN_REASON_CODES.deferredObjectiveAvoid).length,
    dailyBudgetLimitedCount: limited.filter((d) => d.reason?.code === PLAN_REASON_CODES.dailyBudget).length,
    // Counted over ALL devices, not just `limited`: the breaching device has
    // Power-limit control off (`controllable === false` → not held), and a
    // still-sheddable managed device is one PELS could yet ease off (running).
    capacityControlOffCount: devices.filter(isBreachingControlOffDevice).length,
    sheddableManagedRunningCount: devices.filter(isSheddableManagedRunningDevice).length,
  });
};

// ─── Power bar helpers ────────────────────────────────────────────────────────

const pctOf = (kw: number, scaleKw: number): number =>
  Math.max(0, Math.min(100, (kw / scaleKw) * 100));

type BarScale = {
  total: number;
  controlled: number;
  uncontrolled: number;
  safePaceKw: number;
  hardCapKw: number;
  scaleKw: number;
  softLimitSource: PlanMetaSnapshot['softLimitSource'];
  budgetPaceKw: number | null;
  projectedExemptKw: number | null;
};

type MeterMarker = {
  kind: 'projected' | 'target' | 'cap';
  positionPct: number;
  tone?: MeterTone;
  tooltip?: string;
  // Short legend label and screen-reader label, sourced from
  // `shared-domain/planHeroSummary.formatPowerMeterMarkerLabels` /
  // `formatEnergyMeterMarkerLabels` so wording stays in sync with the runtime
  // logger.
  labels: HeroMeterMarkerLabels;
};

type MeterTone = 'good' | 'warning' | 'critical';
type ProjectionTone = 'good' | 'warning' | 'critical';

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

const computePowerBarScale = (
  headline: HeroHeadline,
  meta: PlanMetaSnapshot,
): BarScale | null => {
  // `meta.softLimitKw` alone: it is required on the wire, and the
  // `?? capacitySoftLimitKw ?? 0` chain this used to carry was two fallbacks
  // deep on a value the planner writes every cycle. The `<= 0` guard stays —
  // a zero safe pace is a real configuration, not an absent one.
  const safePaceKw = meta.softLimitKw;
  if (safePaceKw <= 0) return null;
  const total = Math.max(0, headline.totalKw);
  const controlled = Math.max(0, Math.min(total, headline.controlledKw));
  // Derive background as the residual after the managed segment. `totalKw`,
  // `controlledKw`, and `uncontrolledKw` are each rounded independently in the
  // plan meta, so using `headline.uncontrolledKw` directly can make the rendered
  // bar (managed + background) disagree with the headline kW value. Computing
  // the residual keeps the segmented gauge consistent with the number above it
  // and ensures over-threshold tones reflect the full draw.
  const uncontrolled = Math.max(0, total - controlled);
  const hardCapKw = headline.hardLimitKw;
  const scaleKw = Math.max(safePaceKw * 1.2, hardCapKw, total * 1.05);
  return {
    total,
    controlled,
    uncontrolled,
    safePaceKw,
    hardCapKw,
    scaleKw,
    softLimitSource: meta.softLimitSource,
    budgetPaceKw: meta.budgetPaceKw,
    projectedExemptKw: meta.projectedExemptKw,
  };
};

type EnergyBarScale = {
  usedKWh: number;
  budgetKWh: number;
  // The hard cap expressed as this hour's kWh ceiling (cap kW × 1 h). The
  // budget is `cap − safety margin`, so this sits above `budgetKWh`; crossing
  // it is what "Above hard cap" means (an hourly-average tariff-step boundary,
  // never an instantaneous kW comparison).
  hardCapKWh: number | null;
  controlledKWh: number;
  uncontrolledKWh: number;
  projectedKWh: number | null;
};

const computeEnergyBarScale = (meta: PlanMetaSnapshot): EnergyBarScale | null => {
  const { usedKWh, hourControlledKWh, hourUncontrolledKWh } = meta;
  const budgetKWh = meta.hourBudgetKWh;
  // Only the real question survives: a zero allocation means there is no energy
  // bar to draw. `usedKWh` and `budgetKWh` are both required on the wire, so
  // the two `typeof` checks that used to sit here asked whether the planner had
  // done its job.
  if (budgetKWh <= 0) return null;
  const { totalKw, minutesRemaining } = meta;
  // The zero floor for net-export hours lives in the shared helper (also used
  // by the `pels_status` producer for the "Above hard cap" trajectory flag).
  // Keep `null` (no power/time signal) distinct from a clamped 0.
  const projectedKWh = totalKw !== null && minutesRemaining !== null
    ? computeProjectedHourEnergyKWh({ usedKWh, totalKw, minutesRemainingInHour: minutesRemaining })
    : null;
  return {
    usedKWh,
    budgetKWh,
    hardCapKWh: meta.hardCapLimitKw,
    controlledKWh: typeof hourControlledKWh === 'number' ? Math.max(0, hourControlledKWh) : 0,
    uncontrolledKWh: typeof hourUncontrolledKWh === 'number' ? Math.max(0, hourUncontrolledKWh) : 0,
    projectedKWh,
  };
};

// 'critical' = on pace past the hard cap itself — the hour is projected to
// land on a higher tariff step, the one genuinely alarming trajectory. The
// cap rung is checked FIRST via the shared predicate (same verdict as the
// `pels_status` producer's `projectedOverHardCap`; the good-band tolerance
// must never mask it) and never fires when no cap is known. 'warning' = on
// pace past the hourly budget — usually cap − safety margin, but the tighter
// daily-pacing allocation when that binds — which exists to absorb exactly
// this, so it stays a warn.
const resolveProjectionTone = (scale: EnergyBarScale): ProjectionTone => {
  if (scale.projectedKWh === null) return 'good';
  if (isProjectedOverHardCap({ projectedKWh: scale.projectedKWh, hardCapKWh: scale.hardCapKWh })) {
    return 'critical';
  }
  const overage = scale.projectedKWh - scale.budgetKWh;
  const tolerance = Math.max(scale.budgetKWh * 0.02, 0.05);
  if (overage <= tolerance) return 'good';
  return 'warning';
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const Chip = ({ label, tone }: { label: string; tone: string }) => (
  <span class={`plan-chip plan-chip--${tone}`}>{label}</span>
);

// The settings webview does not load Material Symbols font, so the info icon
// is an inline SVG. `currentColor` keeps it tracking the icon-button text token.
const InfoIcon = () => (
  <svg
    class="plan-hero__info-icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="11" x2="12" y2="16" />
    <circle cx="12" cy="8" r="0.5" fill="currentColor" />
  </svg>
);

// Overview hero answers "am I OK right now?". The chip rail is pared back to
// the live status signal plus a freshness chip when data is stale. Mode and
// price-level chips were demoted in PR9 (owner walk 2026-05-17): mode is a
// stable filter belonging to page chrome, and price-level is a Budget concern.
// See notes/overview-hero-spec.md § "Chip row".
const HeroChipRow = ({
  heroStatus,
  freshnessState,
  ageText,
}: {
  heroStatus: HeroStatus;
  freshnessState: FreshnessState | undefined;
  ageText: string | null;
}) => {
  const freshness = formatFreshnessChip(freshnessState);
  // Hide freshness chip when data is fresh — chip rail stays calm on the
  // happy path. (notes/overview-hero-spec.md — "Freshness chip".)
  const showFreshness = freshness !== null && freshness.kind !== 'fresh';
  const freshnessTooltip = ageText ? `Power reading updated ${ageText}` : undefined;
  const statusLabel = HERO_STATUS_LABEL[heroStatus] ?? null;
  return (
    <div class="plan-hero__chips">
      <div class="plan-hero__chip-rail">
        {statusLabel && <Chip label={statusLabel} tone={HERO_STATUS_CHIP_TONE[heroStatus]} />}
        {showFreshness && (
          <span class={`plan-chip plan-chip--${freshness.tone}`} data-tooltip={freshnessTooltip}>
            {freshness.label}
          </span>
        )}
      </div>
      <MdIconButton
        class="plan-hero__info-button"
        type="button"
        aria-label="About this card"
        data-tooltip={HERO_INFO_TOOLTIP_TEXT}
      >
        <InfoIcon />
      </MdIconButton>
    </div>
  );
};

// Power bar segments: [managed][background][free], rendered as proportional
// blocks against `scaleKw`. The trailing rendered segment carries the
// over-threshold tone when the cumulative draw is past the safe pace, so the
// tone follows what is actually drawn (`controlled + uncontrolled`) rather
// than a separate `total` that may include unaccounted load. When the
// background segment is absent (managed load alone exceeds the threshold) the
// managed segment becomes the trailing block and carries the tone — otherwise
// a green bar would silently under-report a threshold violation. There is
// deliberately no instantaneous over-hard-cap tone: the cap is an
// hourly-average ceiling, so the alert story lives on the chip/rim and the
// energy bar's projection marker instead.
const PowerMeterSegments = ({
  scale,
  isLimiting,
}: {
  scale: BarScale;
  isLimiting: boolean;
}) => {
  const managedPct = pctOf(scale.controlled, scale.scaleKw);
  const backgroundPct = pctOf(scale.uncontrolled, scale.scaleKw);
  const drawnKw = scale.controlled + scale.uncontrolled;
  const overSafePace = drawnKw > scale.safePaceKw;
  // The overflow tone is applied to the trailing visible segment. Background
  // gets it whenever it is present; managed gets it only when background is
  // absent so the two segments never both carry the tone.
  const managedTrailing = backgroundPct <= 0;
  // Gentle managed-segment breathing (v2.7.3) is the hero's single live
  // moment: 3.5s opacity oscillation while PELS is actively limiting. The CSS
  // rule respects `prefers-reduced-motion: reduce`.
  return (
    <span class="pels-meter-segments" aria-hidden="true">
      {managedPct > 0 && (
        <span
          class="pels-meter-segments__seg pels-meter-segments__seg--managed"
          style={{ width: `${managedPct}%` }}
          data-over-safe-pace={managedTrailing && overSafePace ? '' : undefined}
          data-limiting={isLimiting ? '' : undefined}
        />
      )}
      {backgroundPct > 0 && (
        <span
          class="pels-meter-segments__seg pels-meter-segments__seg--background"
          style={{ width: `${backgroundPct}%` }}
          data-over-safe-pace={overSafePace ? '' : undefined}
        />
      )}
    </span>
  );
};

const PelsMeterTrack = ({
  fill,
  markers,
}: {
  fill: ComponentChild;
  markers: MeterMarker[];
}) => (
  <div class="pels-meter-track">
    {fill}
    {markers.map((marker) => (
      // `role="img"` + `aria-label` give screen readers the same content the
      // sighted user sees on the tippy.js tooltip wired by `data-tooltip`.
      // Avoid native `title=` here because `setTooltip` strips it when
      // `data-tooltip` is present (see `tooltips.ts`) — native tooltips would
      // also stack on top of the tippy popover.
      <span
        key={marker.kind}
        role="img"
        aria-label={marker.labels.aria}
        class={`pels-meter-track__marker pels-meter-track__marker--${marker.kind}`}
        style={{ left: `${clampPct(marker.positionPct)}%` }}
        data-tone={marker.tone}
        data-tooltip={marker.tooltip}
      />
    ))}
  </div>
);

// Sublegend rendered below a meter for every marker it carries. A marker's
// meaning otherwise lives only in its `aria-label` + a tippy.js tooltip, and
// the tooltip is non-discoverable on touch (no hover) — so even a SINGLE
// marker (e.g. the safe-pace tick on a power bar with no hard cap) needs a
// visible key, not just a colour cue. Hidden from screen readers
// (`aria-hidden`) because the per-marker `aria-label` already describes each
// marker.
const MeterLegend = ({ markers }: { markers: MeterMarker[] }) => {
  if (markers.length < 1) return null;
  return (
    <div class="plan-hero__legend" aria-hidden="true">
      {markers.map((marker) => (
        <span key={marker.kind} class="plan-hero__legend-item">
          <span
            class={`plan-hero__legend-swatch plan-hero__legend-swatch--${marker.kind}`}
            data-tone={marker.tone}
          />
          <span class="plan-hero__legend-label">{marker.labels.short}</span>
        </span>
      ))}
    </div>
  );
};

const PowerMeter = ({ scale, isLimiting }: { scale: BarScale; isLimiting: boolean }) => {
  const safePaceTooltip = formatSafePaceTooltip(scale.safePaceKw, scale.softLimitSource, {
    budgetPaceKw: scale.budgetPaceKw,
    projectedExemptKw: scale.projectedExemptKw,
  });
  const markers: MeterMarker[] = [
    {
      kind: 'target',
      positionPct: pctOf(scale.safePaceKw, scale.scaleKw),
      tooltip: safePaceTooltip,
      labels: formatPowerMeterMarkerLabels('target', scale.safePaceKw),
    },
  ];
  // The cap tick ALWAYS renders — including when the dynamic safe pace sits at
  // or above it (legitimate late in an under-used hour). Hiding it in that
  // state left the bar without its reference line exactly when users wondered
  // where the cap was. The `!== null` gate this replaces could never fire:
  // the cap comes from `capacitySettings.limitKw`, which is always configured,
  // and `notes/ui-terminology.md` says the tick always renders.
  markers.push({
    kind: 'cap',
    positionPct: pctOf(scale.hardCapKw, scale.scaleKw),
    tooltip: formatHardCapTooltip(scale.hardCapKw),
    labels: formatPowerMeterMarkerLabels('cap', scale.hardCapKw),
  });
  return (
    <>
      <PelsMeterTrack fill={<PowerMeterSegments scale={scale} isLimiting={isLimiting} />} markers={markers} />
      <MeterLegend markers={markers} />
    </>
  );
};

// Two mutually exclusive sublines under the Power-now headline, matching
// `notes/overview-hero-spec.md` § "Power now":
//   - on track:           "Safe pace now 12.0 kW · set by this hour's pace"
//   - above safe pace:    "1.5 kW above safe pace (12.0 kW · set by today's budget)"
// The subline only ever compares against the safe pace PELS reacts to — never
// against the hard cap, which is an hourly-average ceiling, not an
// instantaneous threshold.
//
// The source clause is the hero's half of the 2026-08-02 split: the hero names
// the ceiling limiting the HOUSE, device cards state what each device needs.
// Since the cards stopped repeating it, this is where the owner learns it — so
// it is visible text, not the hover tooltip it used to be (nothing hovers in the
// Homey WebView).
const resolvePowerSubline = (
  headline: HeroHeadline,
  softLimitSource: PlanMetaSnapshot['softLimitSource'],
): string => {
  const sourceText = resolveSafePaceSourceText(softLimitSource);
  return headline.overSoftLimit
    ? formatAboveSafePaceSubline(headline.headroomKw, headline.softLimitKw, sourceText)
    : formatSafePaceSubline(headline.softLimitKw, sourceText);
};

const PowerSection = ({
  headline,
  meta,
  isLimiting,
  solarNowText,
  hasControllableDevice,
}: {
  headline: HeroHeadline;
  meta: PlanMetaSnapshot;
  isLimiting: boolean;
  solarNowText: string | null;
  hasControllableDevice: boolean;
}) => {
  const scale = computePowerBarScale(headline, meta);
  const safePaceComposition = scale === null ? null : formatSafePaceComposition(
    scale.safePaceKw,
    scale.softLimitSource,
    {
      budgetPaceKw: scale.budgetPaceKw,
      projectedExemptKw: scale.projectedExemptKw,
    },
  );
  // M3: one tonal story per surface. The hero rim + status chip already carry
  // the warn/alert signal — the headline tone stays neutral.
  return (
    <div class="plan-hero__section">
      <p class="plan-hero__section-label eyebrow">Power now</p>
      <div class="plan-hero__headline plan-hero__metric">
        <span class="plan-hero__metric-value">{headline.totalKw.toFixed(1)}</span>
        {' '}
        <span class="plan-hero__metric-qualifier">kW</span>
      </div>
      <div class="plan-hero__subline">{resolvePowerSubline(headline, meta.softLimitSource)}</div>
      {solarNowText !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted" id="plan-hero-solar-now">
          {solarNowText}
        </div>
      )}
      {scale && (
        <div class="plan-hero__bar-group">
          <PowerMeter scale={scale} isLimiting={isLimiting} />
          {/* A known-zero split renders ("managed is idle"), but only when the
              house actually has a device PELS can control — for background-only
              households `sumControlledUsageKw` answers a known 0 forever, and a
              permanent "Managed 0.0 kW" line is noise, not reassurance.

              There is no `splitKnown` term any more. It tested
              `controlledKw !== null` — the half that ALWAYS resolves — and the
              headline only exists once the view has established there is a
              meter reading, so both halves are known by construction here. */}
          {hasControllableDevice && (
            <div class="plan-hero__energy-support">
              Managed {scale.controlled.toFixed(1)} kW · Background {scale.uncontrolled.toFixed(1)} kW
            </div>
          )}
          {safePaceComposition !== null && (
            <div class="plan-hero__energy-support plan-hero__safe-pace-composition">
              {safePaceComposition}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const resolveEnergyFillTone = (scale: EnergyBarScale): MeterTone => (
  scale.usedKWh > scale.budgetKWh ? 'warning' : 'good'
);

const EnergyMeterFill = ({ scale, scaleKWh }: { scale: EnergyBarScale; scaleKWh: number }) => (
  <span
    class="pels-meter-track__fill"
    data-tone={resolveEnergyFillTone(scale)}
    style={{ width: `${pctOf(scale.usedKWh, scaleKWh)}%` }}
  />
);

const EnergyMeter = ({ scale }: { scale: EnergyBarScale }) => {
  // Shared with the energy section's projected-text computation so the marker's
  // visual position matches the printed `projected / budget` ratio when under
  // budget. See `computeEnergyBarScaleKWh`.
  const scaleKWh = computeEnergyBarScaleKWh(
    scale.budgetKWh,
    scale.projectedKWh,
    scale.usedKWh,
    scale.hardCapKWh,
  );
  const projectionTone = resolveProjectionTone(scale);
  const markers: MeterMarker[] = [
    {
      kind: 'target',
      positionPct: pctOf(scale.budgetKWh, scaleKWh),
      tooltip: `Budget this hour ${scale.budgetKWh.toFixed(1)} kWh`,
      labels: formatEnergyMeterMarkerLabels('target', scale.budgetKWh),
    },
  ];
  if (scale.projectedKWh !== null) {
    markers.push({
      kind: 'projected',
      positionPct: pctOf(scale.projectedKWh, scaleKWh),
      tone: projectionTone,
      tooltip: `Projected this hour ${scale.projectedKWh.toFixed(2)} kWh`,
      labels: formatEnergyMeterMarkerLabels('projected', scale.projectedKWh),
    });
  }
  // The cap's hourly kWh — the line that turns the projection red — renders in
  // every hour. `computeEnergyBarScaleKWh` includes the cap in the scale, so the
  // `<= scaleKWh` guard below can no longer drop it: the cap normally sits ABOVE
  // the budget (`cap − safety margin`), which used to push it off-scale in
  // exactly the calm hours where seeing it is reassuring.
  if (scale.hardCapKWh !== null && scale.hardCapKWh <= scaleKWh) {
    markers.push({
      kind: 'cap',
      positionPct: pctOf(scale.hardCapKWh, scaleKWh),
      tooltip: formatHardCapEnergyTooltip(scale.hardCapKWh),
      labels: formatEnergyMeterMarkerLabels('cap', scale.hardCapKWh),
    });
  }
  return (
    <>
      <PelsMeterTrack fill={<EnergyMeterFill scale={scale} scaleKWh={scaleKWh} />} markers={markers} />
      <MeterLegend markers={markers} />
    </>
  );
};

const EnergySection = ({
  meta,
  cheapestUpcomingText,
}: {
  meta: PlanMetaSnapshot;
  cheapestUpcomingText: string | null;
}) => {
  const scale = computeEnergyBarScale(meta);
  if (!scale) return null;
  // Numeric-first hero stack: the used value leads as the dominant number, the
  // budget context trails as a quiet qualifier. The split is presentation-only
  // (`formatEnergyUsedOfBudgetParts`); `lead + " " + qualifier` is the canonical
  // wording, pinned verbatim by a test, so a log breadcrumb composed from the
  // same parts could not drift from what is rendered here.
  const usedParts = formatEnergyUsedOfBudgetParts(scale.usedKWh, scale.budgetKWh);
  const projectionTone = resolveProjectionTone(scale);
  // Subtraction (v2.7.3): the warning emoji was redundant — the projection
  // marker on the energy bar already carries the over-budget tone, and the
  // status chip says "Above budget". The minutes-remaining subline was
  // dropped for the same reason (the projection marker implies the time
  // axis). Reducing the subline count keeps the energy section calm.
  const projectedText = formatProjectedEnergySubline(scale.projectedKWh);
  // Tone mapping mirrors the CSS contract in style.css (".plan-hero__subline
  // [data-tone='warn']"): only the warn rung paints amber. The critical /
  // alert rung deliberately falls through to the neutral subline color so
  // "red headline + red subline + red chip + red rim" stays a single tonal
  // voice rather than four redundant ones.
  const projectedTone = projectionTone === 'warning' ? 'warn' : undefined;
  return (
    <div class="plan-hero__section">
      <p class="plan-hero__section-label eyebrow">Energy used this hour</p>
      <div class="plan-hero__headline plan-hero__metric">
        <span class="plan-hero__metric-value">{usedParts.lead}</span>
        {' '}
        <span class="plan-hero__metric-qualifier">{usedParts.qualifier}</span>
      </div>
      {projectedText !== null && (
        <div class="plan-hero__subline" data-tone={projectedTone}>{projectedText}</div>
      )}
      <div class="plan-hero__bar-group">
        <EnergyMeter scale={scale} />
      </div>
      {cheapestUpcomingText !== null && (
        <div class="plan-hero__subline plan-hero__subline--anticipation">
          {cheapestUpcomingText}
        </div>
      )}
    </div>
  );
};

// ─── PlanHero component ───────────────────────────────────────────────────────

export type HeroContext = {
  dryRun: boolean;
};

// Format an upcoming-hour timestamp in the user's locale, 24h clock — matches
// the dayViewChart x-axis convention used elsewhere in the settings UI.
const formatClockTimeShort = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
};

const STALE_PRICE_AGE_MS = 6 * 60 * 60 * 1000;

const resolveCheapestUpcomingText = (
  prices: SettingsUiPricesPayload | null | undefined,
  nowMs: number,
): string | null => {
  if (!prices) return null;
  const combined = prices.combinedPrices;
  if (!combined || typeof combined !== 'object') return null;
  // The combined-prices payload shape lives in
  // `packages/settings-ui/src/ui/combinedPrices.ts` so the horizon chart
  // (`deadlinePlanData.ts`) and this anticipation subline agree on which
  // entries are valid.
  const hours = normalizeCombinedPrices(combined)
    .flatMap((row) => {
      const startsAtMs = new Date(row.startsAt).getTime();
      return Number.isFinite(startsAtMs) ? [{ startsAtMs, price: row.total }] : [];
    });
  if (hours.length === 0) return null;
  // Stale-data gate: if even the latest entry is more than 6h in the past the
  // payload predates the current window and we should not anticipate from it.
  const latest = hours.reduce((best, hour) => (hour.startsAtMs > best ? hour.startsAtMs : best), 0);
  if (latest + STALE_PRICE_AGE_MS < nowMs) return null;
  // Scale to the same display unit the smart-task and Budget price surfaces use
  // (øre → kr ÷ divisor) so adjacent tabs never show the same magnitude in two
  // units — the Overview subline reads `0.32 kr/kWh`, not `32 øre/kWh`.
  const costDisplay = resolveCostDisplayFromCombinedPrices(combined);
  return formatCheapestUpcomingHour({
    hours,
    nowMs,
    unitLabel: resolvePriceUnitLabel(costDisplay),
    divisor: costDisplay.divisor,
    formatClockTime: formatClockTimeShort,
  });
};

export const PlanHero = ({
  plan,
  power,
  prices,
  solarNowInput,
  context,
  renderedAtMs,
  nowMs,
}: {
  plan: PlanSnapshot | null;
  power: SettingsUiPowerStatus | null;
  prices?: SettingsUiPricesPayload | null;
  solarNowInput?: SolarNowInput | null;
  context: HeroContext;
  renderedAtMs: number;
  nowMs: number;
}) => {
  const meta = plan?.meta;
  const devices: PlanDeviceSnapshot[] = plan
    ? resolveDisplayPlanDevices(plan, plan.devices ?? [], renderedAtMs, nowMs) as PlanDeviceSnapshot[]
    : [];

  // The one question the hero has to ask before it can render numbers: is there
  // a meter reading this cycle? The capacity guard holds `null` until its
  // meter's first sample, and again after an in-place meter swap
  // (`SuffixedTrackerPersistence.resetFreshness`). `uncontrolledKw` is the whole-home total minus the
  // managed side, so it is absent exactly when the total is — the pair is one
  // fact, checked once, and both checks are needed only because the compiler
  // cannot see that they move together.
  //
  // Answering it HERE is what lets `formatHeroHeadline` be total and
  // `PlanHeroMetaInput` be strict. shared-domain sits inward of this decision
  // and carries no "maybe there is no power" case.
  const heroMeta: PlanHeroMetaInput | null
    = meta !== undefined && meta.totalKw !== null && meta.uncontrolledKw !== null
      ? { ...meta, totalKw: meta.totalKw, uncontrolledKw: meta.uncontrolledKw }
      : null;
  if (heroMeta === null || meta === undefined) {
    return (
      <div class="plan-hero pels-hero" aria-live="polite" aria-busy="true">
        <div class="plan-hero__placeholder pels-skeleton-stack" aria-hidden="true">
          <span class="pels-skeleton pels-skeleton--headline"></span>
          <span class="pels-skeleton pels-skeleton--subline"></span>
          <span class="pels-skeleton pels-skeleton--hero"></span>
        </div>
        <span class="visually-hidden">Loading overview…</span>
      </div>
    );
  }

  const headline = formatHeroHeadline(heroMeta, nowMs);
  const freshnessState = resolveFreshnessState(power, meta);
  const energyScale = computeEnergyBarScale(meta);
  const projectionTone = energyScale ? resolveProjectionTone(energyScale) : null;
  // The over-cap trajectory verdict is computed from the same four meta fields
  // the `pels_status` producer uses — NOT via `projectionTone`, which is gated
  // on the energy bar existing (`hourBudgetKWh > 0`). A zero-allocation
  // daily-budget hour hides the energy section but can still be on pace past
  // the cap; the chip and the widget must agree on that verdict.
  // Reads the RESOLVED input, not the raw wire meta: `heroMeta.totalKw` is a
  // number by construction (the view established there is a reading before
  // building it), and `usedKWh` / `minutesRemaining` are required. The three
  // `typeof` guards this replaces were the last place the hero re-asked whether
  // the planner had produced its own required fields.
  const projectedOverHardCap = isProjectedOverHardCap({
    projectedKWh: computeProjectedHourEnergyKWh({
      usedKWh: meta.usedKWh,
      totalKw: heroMeta.totalKw,
      minutesRemainingInHour: meta.minutesRemaining,
    }),
    hardCapKWh: headline.hardLimitKw,
  });
  const heroStatus = resolveHeroStatus(
    headline,
    devices,
    freshnessState,
    context.dryRun,
    projectionTone,
    projectedOverHardCap,
  );
  const safePaceKw = meta.softLimitKw;
  const decision = buildDecisionSentence({
    devices,
    freshnessState,
    dryRun: context.dryRun,
    projectedOverHardCap,
    projectionTone,
    safePaceKw,
  });
  // The breathing animation runs only while the hero is actually limiting —
  // gated by an active limiting status (`above-safe-pace` or `over-hard-cap`)
  // *and* the presence of held devices, so a transient over-safe-pace blip
  // without active sheds stays still.
  const isLimiting = (heroStatus === 'above-safe-pace' || heroStatus === 'over-hard-cap')
    && devices.some(isLimitedDevice);
  const cheapestUpcomingText = resolveCheapestUpcomingText(prices, nowMs);
  // "Solar now" subline: resolver owns every gate (finiteness, staleness,
  // < 50 W production) — a stale or non-solar sample simply yields no line.
  const solarNow = resolveSolarNow(solarNowInput ?? null, nowMs);
  const solarNowText = solarNow !== null ? formatSolarNowSubline(solarNow) : null;

  return (
    <div class="plan-hero pels-hero" data-tone={HERO_STATUS_DATA_TONE[heroStatus]} aria-live="polite">
      <HeroChipRow
        heroStatus={heroStatus}
        freshnessState={freshnessState}
        ageText={headline.ageText}
      />
      <PowerSection
        headline={headline}
        meta={meta}
        isLimiting={isLimiting}
        solarNowText={solarNowText}
        hasControllableDevice={devices.some((d) => d.controllable)}
      />
      <EnergySection meta={meta} cheapestUpcomingText={cheapestUpcomingText} />
      <p class="plan-hero__decision" data-positive={decision.positive ? '' : undefined}>
        {decision.text}
      </p>
    </div>
  );
};
