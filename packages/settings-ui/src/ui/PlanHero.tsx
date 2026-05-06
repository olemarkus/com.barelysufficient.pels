import {
  formatFreshnessChip,
  formatHeroHeadline,
} from '../../../shared-domain/src/planHeroSummary.ts';
import { resolveDisplayPlanDevices } from './planLiveData.ts';
import type { PlanDeviceSnapshot, PlanMetaSnapshot, PlanSnapshot } from './planTypes.ts';
import type { SettingsUiPowerStatus } from '../../../contracts/src/settingsUiApi.ts';

type FreshnessState = NonNullable<SettingsUiPowerStatus['powerFreshnessState']>;
type HeroStatus = 'on-track' | 'above-safe-pace' | 'over-hard-cap' | 'dry-run' | 'no-data';

const HERO_STATUS_LABEL: Record<HeroStatus, string> = {
  'on-track': 'On track',
  'above-safe-pace': 'Above safe pace',
  'over-hard-cap': 'Over hard cap',
  'dry-run': 'Dry-run',
  'no-data': 'No data',
};

const HERO_STATUS_CHIP_TONE: Record<HeroStatus, string> = {
  'on-track': 'ok',
  'above-safe-pace': 'warn',
  'over-hard-cap': 'alert',
  'dry-run': 'warn',
  'no-data': 'alert',
};

const HERO_STATUS_DATA_TONE: Record<HeroStatus, string> = {
  'on-track': 'ok',
  'above-safe-pace': 'warn',
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
): HeroStatus => {
  if (freshnessState === 'stale_fail_closed') return 'no-data';
  if (headline.overHardLimit) return 'over-hard-cap';
  const limitedCount = devices.filter((d) => d.stateKind === 'held').length;
  if (dryRun && limitedCount > 0) return 'dry-run';
  if (headline.overSoftLimit) return 'above-safe-pace';
  return 'on-track';
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const buildDecisionSentence = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  devices: PlanDeviceSnapshot[],
  freshnessState: FreshnessState | undefined,
  dryRun: boolean,
): { text: string; positive: boolean } => {
  if (freshnessState === 'stale_fail_closed') {
    return { text: 'No live power data — keeping devices limited until readings return.', positive: false };
  }
  if (headline.overHardLimit) {
    return { text: 'Hard cap exceeded — limiting devices now.', positive: false };
  }
  const limitedCount = devices.filter((d) => d.stateKind === 'held').length;
  if (dryRun && limitedCount > 0) {
    return { text: `Would limit ${plural(limitedCount, 'device')} — dry-run is enabled.`, positive: false };
  }
  if (headline.overSoftLimit) {
    if (limitedCount > 0) {
      return { text: `Limiting ${plural(limitedCount, 'device')} — power is above the safe pace.`, positive: false };
    }
    return { text: 'Power is above the safe pace — limiting devices.', positive: false };
  }
  const restoringCount = devices.filter((d) => d.stateKind === 'resuming').length;
  if (restoringCount > 0) {
    return {
      text: `Resuming ${plural(restoringCount, 'device')} — power has stayed below the safe pace.`,
      positive: true,
    };
  }
  return { text: 'No action needed — this hour is on track.', positive: true };
};

// ─── Power bar helpers ────────────────────────────────────────────────────────

const pctOf = (kw: number, scaleKw: number): number =>
  Math.max(0, Math.min(100, (kw / scaleKw) * 100));

const resolveCellCount = (scaleKw: number): number => {
  const step = scaleKw <= 12 ? 1 : 2;
  return Math.max(2, Math.round(scaleKw / step));
};

type BarScale = {
  total: number;
  controlled: number;
  uncontrolled: number;
  safePaceKw: number;
  hardCapKw: number | null;
  scaleKw: number;
};

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

// ─── Sub-components ───────────────────────────────────────────────────────────

const Chip = ({ label, tone }: { label: string; tone: string }) => (
  <span class={`plan-chip plan-chip--${tone}`}>{label}</span>
);

const INFO_TOOLTIP = [
  'Power now is measured in kW — how fast electricity is being used right now.',
  'Energy this hour is measured in kWh — how much has been used so far this hour.',
  'Safe pace is the highest power rate that keeps this hour on track for the energy budget.',
  'kW is speed. kWh is distance.',
].join(' ');

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
  const freshnessTooltip = ageText ? `Power reading updated ${ageText}` : undefined;
  return (
    <div class="plan-hero__chips">
      <Chip label={HERO_STATUS_LABEL[heroStatus]} tone={HERO_STATUS_CHIP_TONE[heroStatus]} />
      {activeMode && <Chip label={`Mode: ${activeMode}`} tone="muted" />}
      {freshness && freshness.kind !== 'fresh' && (
        <span class={`plan-chip plan-chip--${freshness.tone}`} data-tooltip={freshnessTooltip}>{freshness.label}</span>
      )}
      <button
        type="button"
        class="plan-hero__info"
        aria-label="Hero legend"
        data-tooltip={INFO_TOOLTIP}
      >
        ⓘ
      </button>
    </div>
  );
};

const PowerBarSegments = ({ scale }: { scale: BarScale }) => {
  const managedPct = pctOf(Math.min(scale.controlled, scale.total), scale.scaleKw);
  const otherPct = pctOf(
    Math.min(scale.uncontrolled, Math.max(scale.total - scale.controlled, 0)),
    scale.scaleKw,
  );
  const freePct = pctOf(Math.max(scale.safePaceKw - scale.total, 0), scale.scaleKw);
  const fillerPct = Math.max(0, 100 - managedPct - otherPct - freePct);
  return (
    <div
      class="plan-hero__segments"
      style={{ '--cell-count': String(resolveCellCount(scale.scaleKw)) } as Record<string, string>}
    >
      {managedPct > 0 && <span class="plan-hero__seg plan-hero__seg--managed" style={{ flexBasis: `${managedPct}%` }} />}
      {otherPct > 0 && <span class="plan-hero__seg plan-hero__seg--other" style={{ flexBasis: `${otherPct}%` }} />}
      {freePct > 0 && <span class="plan-hero__seg plan-hero__seg--free" style={{ flexBasis: `${freePct}%` }} />}
      {fillerPct > 0 && <span class="plan-hero__seg plan-hero__seg--filler" style={{ flexBasis: `${fillerPct}%` }} />}
    </div>
  );
};

const PowerBar = ({ scale }: { scale: BarScale }) => {
  const safePaceTooltip = [
    `Safe pace ${scale.safePaceKw.toFixed(1)} kW —`,
    'PELS limits managed devices above this threshold.',
  ].join(' ');
  const hardCapTooltip = scale.hardCapKw !== null
    ? [`Hard cap ${scale.hardCapKw.toFixed(1)} kW —`, 'your configured maximum capacity.'].join(' ')
    : undefined;
  const overStart = scale.total > scale.safePaceKw ? pctOf(scale.safePaceKw, scale.scaleKw) : null;
  const overEnd = overStart !== null ? pctOf(scale.total, scale.scaleKw) : null;
  const overWidth = overStart !== null && overEnd !== null ? Math.max(overEnd - overStart, 0.5) : null;
  return (
    <div class="plan-hero__bar">
      <PowerBarSegments scale={scale} />
      {overWidth !== null && overStart !== null && (
        <span class="plan-hero__seg--over" style={{ left: `${overStart}%`, width: `${overWidth}%` }} />
      )}
      <span
        class="plan-hero__tick plan-hero__tick--safe-pace"
        style={{ left: `${pctOf(scale.safePaceKw, scale.scaleKw)}%` }}
        data-tooltip={safePaceTooltip}
      />
      {scale.hardCapKw !== null && scale.hardCapKw > scale.safePaceKw && (
        <span
          class="plan-hero__tick plan-hero__tick--hard-cap"
          style={{ left: `${pctOf(scale.hardCapKw, scale.scaleKw)}%` }}
          data-tooltip={hardCapTooltip}
        />
      )}
    </div>
  );
};

const PowerSection = ({
  headline,
  meta,
  hasHeldDevices,
}: {
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>;
  meta: PlanMetaSnapshot;
  hasHeldDevices: boolean;
}) => {
  const scale = computePowerBarScale(headline, meta);
  return (
    <div class="plan-hero__section">
      <span class="plan-hero__section-label">Power now</span>
      <div class="plan-hero__headline">{headline.totalKw.toFixed(1)} kW now</div>
      {headline.overSoftLimit && (
        <div class="plan-hero__subline" data-tone="warn">
          {Math.max(0, -headline.headroomKw).toFixed(1)} kW above safe pace
        </div>
      )}
      {!headline.overSoftLimit && hasHeldDevices && (
        <div class="plan-hero__subline">
          Safe pace {headline.softLimitKw.toFixed(1)} kW
        </div>
      )}
      {scale && (
        <div class="plan-hero__bar-group">
          <PowerBar scale={scale} />
          <div class="plan-hero__legend">
            <span class="plan-hero__energy-support">
              {scale.controlled > 0
                ? `Managed ${scale.controlled.toFixed(1)} kW`
                : 'No managed load active'
              } · Other load {scale.uncontrolled.toFixed(1)} kW
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

const EnergyBarSegments = ({ scale }: { scale: EnergyBarScale }) => {
  const managedPct = Math.max(0, Math.min(100, (scale.controlledKWh / scale.budgetKWh) * 100));
  const otherPct = Math.max(
    0,
    Math.min(100 - managedPct, (scale.uncontrolledKWh / scale.budgetKWh) * 100),
  );
  const usedPct = Math.min(100, (scale.usedKWh / scale.budgetKWh) * 100);
  const freePct = Math.max(0, 100 - usedPct);
  const fillerPct = Math.max(0, 100 - managedPct - otherPct - freePct);
  return (
    <div class="plan-hero__segments plan-hero__segments--energy">
      {managedPct > 0 && <span class="plan-hero__seg plan-hero__seg--managed" style={{ flexBasis: `${managedPct}%` }} />}
      {otherPct > 0 && <span class="plan-hero__seg plan-hero__seg--other" style={{ flexBasis: `${otherPct}%` }} />}
      {fillerPct > 0 && <span class="plan-hero__seg plan-hero__seg--filler" style={{ flexBasis: `${fillerPct}%` }} />}
      {freePct > 0 && <span class="plan-hero__seg plan-hero__seg--free" style={{ flexBasis: `${freePct}%` }} />}
    </div>
  );
};

const EnergySection = ({ meta }: { meta: PlanMetaSnapshot }) => {
  const scale = computeEnergyBarScale(meta);
  if (!scale) return null;
  const minutesRemaining = typeof meta.minutesRemaining === 'number' ? meta.minutesRemaining : null;
  const usedText = `${scale.usedKWh.toFixed(2)} of ${scale.budgetKWh.toFixed(1)} kWh used`;
  let headlineText = usedText;
  if (scale.projectedKWh !== null) {
    const overWarning = scale.projectedKWh > scale.budgetKWh ? ' ⚠' : '';
    headlineText = `${usedText} · projected ${scale.projectedKWh.toFixed(2)} kWh${overWarning}`;
  }
  const projectedPct = scale.projectedKWh !== null ? Math.min(99, (scale.projectedKWh / scale.budgetKWh) * 100) : null;
  const projectedOver = scale.projectedKWh !== null && scale.projectedKWh > scale.budgetKWh;
  const projectedTooltip = scale.projectedKWh !== null
    ? (projectedOver
      ? `Projected ${scale.projectedKWh.toFixed(2)} kWh — above the hourly budget`
      : `Projected ${scale.projectedKWh.toFixed(2)} kWh this hour`)
    : undefined;
  return (
    <div class="plan-hero__section">
      <span class="plan-hero__section-label">Energy this hour</span>
      <div class="plan-hero__headline plan-hero__headline--sm">{headlineText}</div>
      {minutesRemaining !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{Math.round(minutesRemaining)} min left</div>
      )}
      <div class="plan-hero__bar-group">
        <div class="plan-hero__bar">
          <EnergyBarSegments scale={scale} />
          {scale.usedKWh > scale.budgetKWh && (
            <span class="plan-hero__seg--over" style={{ left: '99%', width: '1%' }} />
          )}
          {projectedPct !== null && (
            <span
              class={`plan-hero__tick plan-hero__tick--${projectedOver ? 'projected-over' : 'projected'}`}
              style={{ left: `${projectedPct}%` }}
              data-tooltip={projectedTooltip}
            />
          )}
        </div>
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
  const heroStatus = resolveHeroStatus(headline, devices, freshnessState, context.dryRun);
  const hasHeldDevices = devices.some((d) => d.stateKind === 'held');
  const { text: decisionText, positive } = buildDecisionSentence(headline, devices, freshnessState, context.dryRun);

  return (
    <div class="plan-hero" data-tone={HERO_STATUS_DATA_TONE[heroStatus]} aria-live="polite">
      <HeroChipRow
        heroStatus={heroStatus}
        activeMode={context.activeMode}
        freshnessState={freshnessState}
        ageText={headline.ageText}
      />
      <PowerSection headline={headline} meta={meta} hasHeldDevices={hasHeldDevices} />
      <EnergySection meta={meta} />
      <p class="plan-hero__decision" data-positive={positive ? '' : undefined}>
        {positive ? `✓ ${decisionText}` : decisionText}
      </p>
    </div>
  );
};
