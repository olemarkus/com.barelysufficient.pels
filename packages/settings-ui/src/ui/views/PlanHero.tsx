import type { ComponentChild } from 'preact';
import {
  formatAboveHardCapSubline,
  formatAboveSafePaceSubline,
  formatEnergyMeterMarkerLabels,
  formatEnergyUsedOfBudget,
  formatFreshnessChip,
  formatHeroHeadline,
  formatPowerMeterMarkerLabels,
  type HeroMeterMarkerLabels,
} from '../../../../shared-domain/src/planHeroSummary.ts';
import {
  HERO_INFO_TOOLTIP_TEXT,
  formatHardCapTooltip,
  formatSafePaceTooltip,
} from '../../../../shared-domain/src/planHeroTooltips.ts';
import { resolveDisplayPlanDevices } from '../planLiveData.ts';
import type { PlanDeviceSnapshot, PlanMetaSnapshot, PlanSnapshot } from '../planTypes.ts';
import type { SettingsUiPowerStatus } from '../../../../contracts/src/settingsUiApi.ts';
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
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  devices: PlanDeviceSnapshot[],
  freshnessState: FreshnessState | undefined,
  dryRun: boolean,
  projectionTone: ProjectionTone | null,
): HeroStatus => {
  if (freshnessState === 'stale_fail_closed') return 'no-data';
  if (headline.overHardLimit) return 'over-hard-cap';
  // Surface the simulation-mode chip whenever there is anything the decision
  // sentence has to phrase hypothetically — that includes devices stuck `held`
  // from before simulation was enabled.
  if (dryRun && devices.some((d) => isWouldLimitDevice(d) || isLimitedDevice(d))) return 'dry-run';
  if (headline.overSoftLimit) return 'above-safe-pace';
  if (projectionTone === 'warning' || projectionTone === 'critical') return 'projected-over-budget';
  return 'on-track';
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const isLimitedDevice = (device: PlanDeviceSnapshot): boolean => (
  device.stateKind === 'held' || device.plannedState === 'shed'
);

const isResumingDevice = (device: PlanDeviceSnapshot): boolean => (
  device.stateKind === 'resuming' || Boolean(device.binaryCommandPending && device.currentState === 'off')
);

// In simulation mode the planner outputs `plannedState === 'shed'` but never
// actually flips device state. Identify devices the planner *would* limit — i.e.
// planner says shed and the device is not already in the held state.
const isWouldLimitDevice = (device: PlanDeviceSnapshot): boolean => (
  device.plannedState === 'shed' && device.stateKind !== 'held'
);

// Decision sentence priority order. Source of truth: `notes/overview-hero-spec.md`,
// section "Decision sentence" — keep this ladder in sync. The projected-over-budget
// branch is added on top so the conclusion never contradicts an "Above budget" chip
// surfaced by `resolveHeroStatus`.
const buildDecisionSentence = ({
  devices,
  freshnessState,
  dryRun,
  overHardLimit,
  overSoftLimit,
  projectionTone,
}: {
  devices: PlanDeviceSnapshot[];
  freshnessState: FreshnessState | undefined;
  dryRun: boolean;
  overHardLimit: boolean;
  overSoftLimit: boolean;
  projectionTone: ProjectionTone | null;
}): { text: string; positive: boolean } => {
  // 1. No data
  if (freshnessState === 'stale_fail_closed') {
    return {
      text: 'No live power data — keeping devices limited until readings return.',
      positive: false,
    };
  }

  // 2. Above hard cap
  if (overHardLimit) {
    return { text: 'Hard cap exceeded — limiting devices now.', positive: false };
  }

  const limitedCount = devices.filter(isLimitedDevice).length;
  const restoringCount = devices.filter(isResumingDevice).length;

  // 3. Simulation mode would act. Use `limitedCount` rather than `wouldLimitCount`
  // so devices stuck in `held` from before simulation was enabled still produce
  // hypothetical phrasing — per spec, the UI must never imply PELS acted in
  // dry-run mode.
  if (dryRun && limitedCount > 0) {
    return {
      text: `Would limit ${plural(limitedCount, 'device')} — simulation mode is enabled.`,
      positive: false,
    };
  }

  // 4. Actively limiting. When current power is below the safe pace (e.g. during
  // cooldown after a recent shed) the "above the safe pace" copy is factually
  // wrong; explain the action with the constraint that is actually binding.
  if (limitedCount > 0) {
    const reason = overSoftLimit
      ? 'current power is above the safe pace'
      : 'staying below the safe pace';
    return {
      text: `Limiting ${plural(limitedCount, 'device')} — ${reason}.`,
      positive: false,
    };
  }

  // 5. Resuming
  if (restoringCount > 0) {
    return {
      text: `Resuming ${plural(restoringCount, 'device')} — power has stayed below the safe pace.`,
      positive: true,
    };
  }

  // 6. Projected over budget — keep the conclusion consistent with the
  // "Above budget" status chip surfaced by `resolveHeroStatus`.
  if (projectionTone === 'warning' || projectionTone === 'critical') {
    return {
      text: 'This hour is projected to go over budget.',
      positive: false,
    };
  }

  // 7. On track
  return { text: 'No action needed — this hour is on track.', positive: true };
};

// ─── Power bar helpers ────────────────────────────────────────────────────────

const pctOf = (kw: number, scaleKw: number): number =>
  Math.max(0, Math.min(100, (kw / scaleKw) * 100));

type BarScale = {
  total: number;
  controlled: number;
  uncontrolled: number;
  safePaceKw: number;
  hardCapKw: number | null;
  scaleKw: number;
  softLimitSource: PlanMetaSnapshot['softLimitSource'];
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
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  meta: PlanMetaSnapshot,
): BarScale | null => {
  const safePaceKw = meta.softLimitKw ?? meta.capacitySoftLimitKw ?? 0;
  if (safePaceKw <= 0) return null;
  const total = Math.max(0, headline.totalKw ?? 0);
  const controlled = Math.max(0, Math.min(total, headline.controlledKw ?? 0));
  // Derive background as the residual after the managed segment. `totalKw`,
  // `controlledKw`, and `uncontrolledKw` are each rounded independently in the
  // plan meta, so using `headline.uncontrolledKw` directly can make the rendered
  // bar (managed + background) disagree with the headline kW value. Computing
  // the residual keeps the segmented gauge consistent with the number above it
  // and ensures over-threshold tones reflect the full draw.
  const uncontrolled = Math.max(0, total - controlled);
  const hardCapKw = headline.hardLimitKw ?? null;
  const scaleKw = Math.max(safePaceKw * 1.2, hardCapKw ?? 0, total * 1.05);
  return {
    total,
    controlled,
    uncontrolled,
    safePaceKw,
    hardCapKw,
    scaleKw,
    softLimitSource: meta.softLimitSource,
  };
};

type EnergyBarScale = {
  usedKWh: number;
  budgetKWh: number;
  controlledKWh: number;
  uncontrolledKWh: number;
  projectedKWh: number | null;
};

const computeEnergyBarScale = (meta: PlanMetaSnapshot): EnergyBarScale | null => {
  const { usedKWh, hourControlledKWh, hourUncontrolledKWh } = meta;
  const budgetKWh = meta.hourBudgetKWh;
  if (typeof usedKWh !== 'number' || typeof budgetKWh !== 'number' || budgetKWh <= 0) return null;
  const totalKw = typeof meta.totalKw === 'number' ? meta.totalKw : null;
  const minutesRemaining = typeof meta.minutesRemaining === 'number' ? meta.minutesRemaining : null;
  const projectedKWh = totalKw !== null && minutesRemaining !== null
    ? usedKWh + (totalKw * minutesRemaining / 60)
    : null;
  return {
    usedKWh,
    budgetKWh,
    controlledKWh: typeof hourControlledKWh === 'number' ? Math.max(0, hourControlledKWh) : 0,
    uncontrolledKWh: typeof hourUncontrolledKWh === 'number' ? Math.max(0, hourUncontrolledKWh) : 0,
    projectedKWh,
  };
};

const resolveProjectionTone = (scale: EnergyBarScale): ProjectionTone => {
  if (scale.projectedKWh === null) return 'good';
  const overage = scale.projectedKWh - scale.budgetKWh;
  const tolerance = Math.max(scale.budgetKWh * 0.02, 0.05);
  if (overage <= tolerance) return 'good';
  if (scale.projectedKWh <= scale.budgetKWh * 1.1) return 'warning';
  return 'critical';
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
// over-threshold tone when the cumulative draw is past safe-pace / hard-cap,
// so the tone follows what is actually drawn (`controlled + uncontrolled`)
// rather than a separate `total` that may include unaccounted load. When the
// background segment is absent (managed load alone exceeds the threshold) the
// managed segment becomes the trailing block and carries the tone — otherwise
// a green bar would silently under-report a threshold violation.
const PowerMeterSegments = ({ scale }: { scale: BarScale }) => {
  const managedPct = pctOf(scale.controlled, scale.scaleKw);
  const backgroundPct = pctOf(scale.uncontrolled, scale.scaleKw);
  const drawnKw = scale.controlled + scale.uncontrolled;
  const overSafePace = drawnKw > scale.safePaceKw;
  const overHardCap = scale.hardCapKw !== null && drawnKw > scale.hardCapKw;
  // The overflow tone is applied to the trailing visible segment. Background
  // gets it whenever it is present; managed gets it only when background is
  // absent so the two segments never both carry the tone.
  const managedTrailing = backgroundPct <= 0;
  return (
    <span class="pels-meter-segments" aria-hidden="true">
      {managedPct > 0 && (
        <span
          class="pels-meter-segments__seg pels-meter-segments__seg--managed"
          style={{ width: `${managedPct}%` }}
          data-over-safe-pace={managedTrailing && overSafePace ? '' : undefined}
          data-over-hard-cap={managedTrailing && overHardCap ? '' : undefined}
        />
      )}
      {backgroundPct > 0 && (
        <span
          class="pels-meter-segments__seg pels-meter-segments__seg--background"
          style={{ width: `${backgroundPct}%` }}
          data-over-safe-pace={overSafePace ? '' : undefined}
          data-over-hard-cap={overHardCap ? '' : undefined}
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

// Sublegend rendered below a meter when it carries more than one marker — a
// single labeled dot reads fine from its `aria-label`, but two or more dots
// need a sighted-user legend so the colors map to meaning. Hidden from screen
// readers (`aria-hidden`) because the per-marker `aria-label` already
// describes each marker.
const MeterLegend = ({ markers }: { markers: MeterMarker[] }) => {
  if (markers.length < 2) return null;
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

const PowerMeter = ({ scale }: { scale: BarScale }) => {
  const safePaceTooltip = formatSafePaceTooltip(scale.safePaceKw, scale.softLimitSource ?? null);
  const markers: MeterMarker[] = [
    {
      kind: 'target',
      positionPct: pctOf(scale.safePaceKw, scale.scaleKw),
      tooltip: safePaceTooltip,
      labels: formatPowerMeterMarkerLabels('target', scale.safePaceKw),
    },
  ];
  if (scale.hardCapKw !== null && scale.hardCapKw > scale.safePaceKw) {
    markers.push({
      kind: 'cap',
      positionPct: pctOf(scale.hardCapKw, scale.scaleKw),
      tooltip: formatHardCapTooltip(scale.hardCapKw),
      labels: formatPowerMeterMarkerLabels('cap', scale.hardCapKw),
    });
  }
  return (
    <>
      <PelsMeterTrack fill={<PowerMeterSegments scale={scale} />} markers={markers} />
      <MeterLegend markers={markers} />
    </>
  );
};

// Three mutually exclusive sublines under the Power-now headline, matching
// `notes/overview-hero-spec.md` § "Power now":
//   - on track:           "Safe pace now 12.0 kW"
//   - above safe pace:    "1.5 kW above safe pace"
//   - above hard cap:     "0.5 kW above hard cap (5.0 kW)"
// `overHardLimit` takes precedence (hard cap implies above safe pace).
const resolvePowerSubline = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  meta: PlanMetaSnapshot,
): string => {
  if (headline.overHardLimit && typeof meta.hardCapHeadroomKw === 'number' && headline.hardLimitKw !== null) {
    return formatAboveHardCapSubline(meta.hardCapHeadroomKw, headline.hardLimitKw);
  }
  if (headline.overSoftLimit) {
    return formatAboveSafePaceSubline(headline.headroomKw);
  }
  return `Safe pace now ${headline.softLimitKw.toFixed(1)} kW`;
};

const PowerSection = ({
  headline,
  meta,
}: {
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>;
  meta: PlanMetaSnapshot;
}) => {
  const scale = computePowerBarScale(headline, meta);
  // M3: one tonal story per surface. The hero rim + status chip already carry
  // the warn/alert signal — the headline tone stays neutral.
  return (
    <div class="plan-hero__section">
      <p class="plan-hero__section-label eyebrow">Power now</p>
      <div class="plan-hero__headline">{headline.totalKw.toFixed(1)} kW</div>
      <div class="plan-hero__subline">{resolvePowerSubline(headline, meta)}</div>
      {scale && (
        <div class="plan-hero__bar-group">
          <PowerMeter scale={scale} />
          <div class="plan-hero__energy-support">
            {scale.controlled > 0
              ? `Managed ${scale.controlled.toFixed(1)} kW`
              : 'No managed load active'
            } · Background {scale.uncontrolled.toFixed(1)} kW
          </div>
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
  const scaleKWh = Math.max(scale.budgetKWh, scale.projectedKWh ?? 0, scale.usedKWh) * 1.05;
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
  return (
    <>
      <PelsMeterTrack fill={<EnergyMeterFill scale={scale} scaleKWh={scaleKWh} />} markers={markers} />
      <MeterLegend markers={markers} />
    </>
  );
};

const EnergySection = ({ meta }: { meta: PlanMetaSnapshot }) => {
  const scale = computeEnergyBarScale(meta);
  if (!scale) return null;
  const minutesRemaining = typeof meta.minutesRemaining === 'number' ? meta.minutesRemaining : null;
  const usedText = formatEnergyUsedOfBudget(scale.usedKWh, scale.budgetKWh);
  const projectionTone = resolveProjectionTone(scale);
  const projectedText = scale.projectedKWh !== null
    ? `projected ${scale.projectedKWh.toFixed(2)} kWh${projectionTone === 'good' ? '' : ' ⚠'}`
    : null;
  const minutesText = minutesRemaining !== null ? `${Math.round(minutesRemaining)} min left` : null;
  return (
    <div class="plan-hero__section">
      <p class="plan-hero__section-label eyebrow">Energy used this hour</p>
      <div class="plan-hero__headline">{usedText}</div>
      {projectedText !== null && (
        <div class="plan-hero__subline">{projectedText}</div>
      )}
      {minutesText !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{minutesText}</div>
      )}
      <div class="plan-hero__bar-group">
        <EnergyMeter scale={scale} />
      </div>
    </div>
  );
};

// ─── PlanHero component ───────────────────────────────────────────────────────

export type HeroContext = {
  dryRun: boolean;
};

export const PlanHero = ({
  plan,
  power,
  context,
  renderedAtMs,
  nowMs,
}: {
  plan: PlanSnapshot | null;
  power: SettingsUiPowerStatus | null;
  context: HeroContext;
  renderedAtMs: number;
  nowMs: number;
}) => {
  const meta = plan?.meta;
  const devices: PlanDeviceSnapshot[] = plan
    ? resolveDisplayPlanDevices(plan, plan.devices ?? [], renderedAtMs, nowMs) as PlanDeviceSnapshot[]
    : [];

  const headline = formatHeroHeadline(meta, nowMs);
  if (!headline || !meta) {
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

  const freshnessState = resolveFreshnessState(power, meta);
  const energyScale = computeEnergyBarScale(meta);
  const projectionTone = energyScale ? resolveProjectionTone(energyScale) : null;
  const heroStatus = resolveHeroStatus(headline, devices, freshnessState, context.dryRun, projectionTone);
  const decision = buildDecisionSentence({
    devices,
    freshnessState,
    dryRun: context.dryRun,
    overHardLimit: headline.overHardLimit,
    overSoftLimit: headline.overSoftLimit,
    projectionTone,
  });

  return (
    <div class="plan-hero pels-hero" data-tone={HERO_STATUS_DATA_TONE[heroStatus]} aria-live="polite">
      <HeroChipRow
        heroStatus={heroStatus}
        freshnessState={freshnessState}
        ageText={headline.ageText}
      />
      <PowerSection headline={headline} meta={meta} />
      <EnergySection meta={meta} />
      <p class="plan-hero__decision" data-positive={decision.positive ? '' : undefined}>
        {decision.text}
      </p>
    </div>
  );
};
