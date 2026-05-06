import {
  formatFreshnessChip,
  formatHeroHeadline,
} from '../../../shared-domain/src/planHeroSummary.ts';
import { resolveDisplayPlanDevices } from './planLiveData.ts';
import type { PlanDeviceSnapshot, PlanMetaSnapshot, PlanSnapshot } from './planTypes.ts';
import type { SettingsUiPowerStatus } from '../../../contracts/src/settingsUiApi.ts';

type FreshnessState = NonNullable<SettingsUiPowerStatus['powerFreshnessState']>;
type HeroStatus = 'on-track' | 'above-safe-pace' | 'projected-over-budget' | 'over-hard-cap' | 'dry-run' | 'no-data';

const HERO_STATUS_LABEL: Partial<Record<HeroStatus, string>> = {
  'above-safe-pace': 'Above safe pace',
  'projected-over-budget': 'Above budget',
  'over-hard-cap': 'Above hard cap',
  'dry-run': 'Dry-run',
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
  const limitedCount = devices.filter(isLimitedDevice).length;
  if (dryRun && limitedCount > 0) return 'dry-run';
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

const formatProjectionStatus = (
  scale: EnergyBarScale,
  minutesRemaining: number | null,
  startOfSentence: boolean,
  includeValue = true,
): string => {
  const tone = resolveProjectionTone(scale);
  const label = resolveProjectionLabel(tone, startOfSentence);
  if (!includeValue) return label;
  const value = `${scale.projectedKWh?.toFixed(2)} / ${scale.budgetKWh.toFixed(1)} kWh`;
  return minutesRemaining !== null
    ? `${label} · ${value} · ${Math.round(minutesRemaining)} min left`
    : `${label} · ${value}`;
};

const buildHeroStatusLine = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  devices: PlanDeviceSnapshot[],
  freshnessState: FreshnessState | undefined,
  dryRun: boolean,
  energyScale: EnergyBarScale | null,
  meta: PlanMetaSnapshot,
): { text: string | null; positive: boolean } => {
  const limitedCount = devices.filter(isLimitedDevice).length;
  const restoringCount = devices.filter(isResumingDevice).length;
  const minutesRemaining = typeof meta.minutesRemaining === 'number' ? meta.minutesRemaining : null;
  const projectionText = energyScale?.projectedKWh !== null && energyScale
    ? formatProjectionStatus(energyScale, minutesRemaining, false)
    : null;
  const projectionSummary = energyScale?.projectedKWh !== null && energyScale
    ? formatProjectionStatus(energyScale, minutesRemaining, false, false)
    : null;
  const appendProjectionSummary = (text: string): string => projectionSummary ? `${text} · ${projectionSummary}` : text;

  if (freshnessState === 'stale_fail_closed') {
    return { text: 'No live power data — keeping devices limited until readings return.', positive: false };
  }
  if (headline.overHardLimit) {
    const hardCapText = headline.hardLimitKw !== null
      ? `Above hard cap of ${headline.hardLimitKw.toFixed(1)} kW`
      : 'Above hard cap';
    const limitingText = limitedCount > 0 ? `limiting ${plural(limitedCount, 'device')} now` : 'limiting devices now';
    return { text: `${hardCapText} · ${limitingText}`, positive: false };
  }
  if (dryRun && limitedCount > 0) {
    return { text: appendProjectionSummary(`Would limit ${plural(limitedCount, 'device')} · dry-run is enabled`), positive: false };
  }
  if (headline.overSoftLimit) {
    if (limitedCount > 0) {
      return { text: appendProjectionSummary(`Above safe pace · limiting ${plural(limitedCount, 'device')}`), positive: false };
    }
    return { text: appendProjectionSummary('Above safe pace · limiting devices'), positive: false };
  }
  if (limitedCount > 0) {
    return { text: appendProjectionSummary(`Limiting ${plural(limitedCount, 'device')}`), positive: false };
  }
  if (restoringCount > 0) {
    return {
      text: appendProjectionSummary(`Resuming ${plural(restoringCount, 'device')} · power has stayed below the safe pace`),
      positive: true,
    };
  }
  if (projectionText) return { text: formatProjectionStatus(energyScale as EnergyBarScale, minutesRemaining, true), positive: true };
  return { text: 'Power is below safe pace', positive: true };
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
};

type MeterMarker = {
  kind: 'actual' | 'projected' | 'target' | 'cap';
  positionPct: number;
  tone?: MeterTone;
  tooltip?: string;
};

type MeterTone = 'good' | 'warning' | 'limited' | 'critical';
type ProjectionTone = 'good' | 'warning' | 'critical';

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

const computePowerBarScale = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  meta: PlanMetaSnapshot,
): BarScale | null => {
  const safePaceKw = meta.softLimitKw ?? meta.capacitySoftLimitKw ?? 0;
  if (safePaceKw <= 0) return null;
  const total = Math.max(0, headline.totalKw ?? 0);
  const controlled = Math.max(0, headline.controlledKw ?? 0);
  const uncontrolled = Math.max(0, headline.uncontrolledKw ?? 0);
  const hardCapKw = headline.hardLimitKw ?? null;
  const scaleKw = Math.max(safePaceKw * 1.2, hardCapKw ?? 0, total * 1.05);
  return { total, controlled, uncontrolled, safePaceKw, hardCapKw, scaleKw };
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
  const budgetKWh = meta.dailyBudgetHourKWh ?? meta.capacityLimitKw ?? meta.budgetKWh;
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

const resolveProjectionLabel = (tone: ProjectionTone, startOfSentence = true): string => {
  const label = tone === 'good'
    ? 'projected on target'
    : tone === 'warning'
      ? 'projected slightly over budget'
      : 'projected over budget';
  return startOfSentence ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : label;
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const Chip = ({ label, tone }: { label: string; tone: string }) => (
  <span class={`plan-chip plan-chip--${tone}`}>{label}</span>
);

const HeroChipRow = ({
  heroStatus,
  activeMode,
  freshnessState,
  ageText,
}: {
  heroStatus: HeroStatus;
  activeMode: string;
  freshnessState: FreshnessState | undefined;
  ageText: string | null;
}) => {
  const freshness = formatFreshnessChip(freshnessState);
  const freshnessText = freshness && freshness.kind !== 'fresh' ? 'Power reading delayed' : null;
  const freshnessTooltip = ageText ? `Power reading updated ${ageText}` : undefined;
  const statusLabel = HERO_STATUS_LABEL[heroStatus] ?? null;
  return (
    <div class="plan-hero__chips">
      {statusLabel && <Chip label={statusLabel} tone={HERO_STATUS_CHIP_TONE[heroStatus]} />}
      {(activeMode || freshnessText) && (
        <span class="plan-hero__meta-row">
          {activeMode && <span class="plan-chip plan-chip--muted">Mode: {activeMode}</span>}
          {freshnessText && (
            <span class="plan-hero__meta" data-tone={freshness.tone} data-tooltip={freshnessTooltip}>
              {freshnessText}
            </span>
          )}
        </span>
      )}
    </div>
  );
};

const PelsMeterTrack = ({
  valuePct,
  tone,
  markers,
}: {
  valuePct: number;
  tone: MeterTone;
  markers: MeterMarker[];
}) => (
  <div
    class="pels-meter-track"
    data-tone={tone}
    style={{ '--meter-value': `${clampPct(valuePct)}%` } as Record<string, string>}
  >
    <span class="pels-meter-track__fill" />
    {markers.map((marker) => (
      <span
        class={`pels-meter-track__marker pels-meter-track__marker--${marker.kind}`}
        style={{ left: `${clampPct(marker.positionPct)}%` }}
        data-tone={marker.tone}
        data-tooltip={marker.tooltip}
      />
    ))}
  </div>
);

const resolvePowerTone = (scale: BarScale): 'good' | 'warning' | 'critical' => {
  if (scale.hardCapKw !== null && scale.total > scale.hardCapKw) return 'critical';
  if (scale.total > scale.safePaceKw) return 'warning';
  return 'good';
};

const PowerMeter = ({ scale }: { scale: BarScale }) => {
  const safePaceTooltip = [
    `Safe pace now ${scale.safePaceKw.toFixed(1)} kW —`,
    'PELS limits managed devices above this threshold.',
  ].join(' ');
  const hardCapTooltip = scale.hardCapKw !== null
    ? [`Hard cap ${scale.hardCapKw.toFixed(1)} kW —`, 'your configured maximum.'].join(' ')
    : undefined;
  const markers: MeterMarker[] = [
    {
      kind: 'actual',
      positionPct: pctOf(scale.total, scale.scaleKw),
      tooltip: `Power being used now ${scale.total.toFixed(1)} kW`,
    },
    {
      kind: 'target',
      positionPct: pctOf(scale.safePaceKw, scale.scaleKw),
      tooltip: safePaceTooltip,
    },
  ];
  if (scale.hardCapKw !== null && scale.hardCapKw > scale.safePaceKw) {
    markers.push({
      kind: 'cap',
      positionPct: pctOf(scale.hardCapKw, scale.scaleKw),
      tooltip: hardCapTooltip,
    });
  }
  return (
    <PelsMeterTrack
      valuePct={pctOf(scale.total, scale.scaleKw)}
      tone={resolvePowerTone(scale)}
      markers={markers}
    />
  );
};

const PowerSection = ({
  headline,
  meta,
}: {
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>;
  meta: PlanMetaSnapshot;
}) => {
  const scale = computePowerBarScale(headline, meta);
  const powerTone = scale ? resolvePowerTone(scale) : null;
  return (
    <div class="plan-hero__section">
      <span class="plan-hero__section-label">Power being used now</span>
      <div class="plan-hero__headline" data-tone={powerTone}>{headline.totalKw.toFixed(1)} kW</div>
      {headline.overHardLimit && headline.hardLimitKw !== null && (
        <div class="plan-hero__subline" data-tone="critical">
          {(headline.totalKw - headline.hardLimitKw).toFixed(1)} kW above hard cap
        </div>
      )}
      {headline.overSoftLimit && !headline.overHardLimit && (
        <div class="plan-hero__subline" data-tone="warn">
          {Math.max(0, -headline.headroomKw).toFixed(1)} kW above safe pace
        </div>
      )}
      {!headline.overSoftLimit && !headline.overHardLimit && (
        <div class="plan-hero__subline">
          Safe pace now {headline.softLimitKw.toFixed(1)} kW
        </div>
      )}
      {scale && (
        <div class="plan-hero__bar-group">
          <div class="plan-hero__legend">
            <span class="plan-hero__energy-support">
              {scale.controlled > 0
                ? `Managed ${scale.controlled.toFixed(1)} kW`
                : 'No managed load active'
              } · Background {scale.uncontrolled.toFixed(1)} kW
            </span>
          </div>
          <PowerMeter scale={scale} />
        </div>
      )}
    </div>
  );
};

const resolveEnergyFillTone = (scale: EnergyBarScale): MeterTone => {
  return scale.usedKWh > scale.budgetKWh ? 'warning' : 'good';
};

const EnergyMeter = ({ scale }: { scale: EnergyBarScale }) => {
  const scaleKWh = Math.max(scale.budgetKWh, scale.projectedKWh ?? 0, scale.usedKWh) * 1.05;
  const projectionTone = resolveProjectionTone(scale);
  const markers: MeterMarker[] = [
    {
      kind: 'actual',
      positionPct: pctOf(scale.usedKWh, scaleKWh),
      tone: scale.usedKWh > scale.budgetKWh ? 'warning' : 'good',
      tooltip: `Energy used so far this hour ${scale.usedKWh.toFixed(2)} kWh`,
    },
    {
      kind: 'target',
      positionPct: pctOf(scale.budgetKWh, scaleKWh),
      tooltip: `Budget this hour ${scale.budgetKWh.toFixed(1)} kWh`,
    },
  ];
  if (scale.projectedKWh !== null) {
    markers.push({
      kind: 'projected',
      positionPct: pctOf(scale.projectedKWh, scaleKWh),
      tone: projectionTone,
      tooltip: `Projected this hour ${scale.projectedKWh.toFixed(2)} kWh`,
    });
  }
  return (
    <PelsMeterTrack
      valuePct={pctOf(scale.usedKWh, scaleKWh)}
      tone={resolveEnergyFillTone(scale)}
      markers={markers}
    />
  );
};

const EnergySection = ({ meta }: { meta: PlanMetaSnapshot }) => {
  const scale = computeEnergyBarScale(meta);
  if (!scale) return null;
  const usedText = `${scale.usedKWh.toFixed(2)} / ${scale.budgetKWh.toFixed(1)} kWh`;
  return (
    <div class="plan-hero__section">
      <span class="plan-hero__section-label">Energy used so far this hour</span>
      <div class="plan-hero__headline" data-tone={scale.usedKWh > scale.budgetKWh ? 'warning' : undefined}>
        {usedText}
      </div>
      <div class="plan-hero__bar-group">
        <EnergyMeter scale={scale} />
      </div>
    </div>
  );
};

// ─── PlanHero component ───────────────────────────────────────────────────────

export type HeroContext = {
  activeMode: string;
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
      <div class="plan-hero" aria-live="polite">
        <p class="plan-hero__placeholder muted">Awaiting data…</p>
      </div>
    );
  }

  const freshnessState = resolveFreshnessState(power, meta);
  const energyScale = computeEnergyBarScale(meta);
  const projectionTone = energyScale ? resolveProjectionTone(energyScale) : null;
  const heroStatus = resolveHeroStatus(headline, devices, freshnessState, context.dryRun, projectionTone);
  const { text: decisionText, positive } = buildHeroStatusLine(
    headline,
    devices,
    freshnessState,
    context.dryRun,
    energyScale,
    meta,
  );

  return (
    <div class="plan-hero" data-tone={HERO_STATUS_DATA_TONE[heroStatus]} aria-live="polite">
      <HeroChipRow
        heroStatus={heroStatus}
        activeMode={context.activeMode}
        freshnessState={freshnessState}
        ageText={headline.ageText}
      />
      <PowerSection headline={headline} meta={meta} />
      <EnergySection meta={meta} />
      {decisionText !== null && (
        <p class="plan-hero__decision" data-positive={positive ? '' : undefined}>
          {decisionText}
        </p>
      )}
    </div>
  );
};
