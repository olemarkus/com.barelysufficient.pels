import { planHero, planHourStrip } from './dom.ts';
import {
  formatFreshnessChip,
  formatHeroHeadline,
} from '../../../shared-domain/src/planHeroSummary.ts';
import { setTooltip } from './tooltips.ts';
import type { SettingsUiPowerStatus } from '../../../contracts/src/settingsUiApi.ts';
import type { PlanDeviceSnapshot, PlanMetaSnapshot } from './planTypes.ts';

type FreshnessState = NonNullable<SettingsUiPowerStatus['powerFreshnessState']>;
type HeroStatus = 'on-track' | 'above-safe-pace' | 'over-hard-cap' | 'dry-run' | 'no-data';

export type HeroContext = {
  activeMode: string;
  dryRun: boolean;
};

// ─── Status resolution ────────────────────────────────────────────────────────

const resolveFreshnessState = (
  powerStatus: SettingsUiPowerStatus | null | undefined,
  meta: PlanMetaSnapshot,
): FreshnessState | undefined => {
  const fromPower = powerStatus?.powerFreshnessState;
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

// ─── Decision sentence ────────────────────────────────────────────────────────

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

type DecisionResult = { text: string; positive: boolean };

const buildDecisionSentence = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  devices: PlanDeviceSnapshot[],
  freshnessState: FreshnessState | undefined,
  dryRun: boolean,
): DecisionResult => {
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

// ─── Chip row ─────────────────────────────────────────────────────────────────

const buildChip = (label: string, tone: string): HTMLSpanElement => {
  const chip = document.createElement('span');
  chip.className = `plan-chip plan-chip--${tone}`;
  chip.textContent = label;
  return chip;
};

const buildInfoButton = (): HTMLButtonElement => {
  const tooltip = [
    'Power now is measured in kW — how fast electricity is being used right now.',
    'Energy this hour is measured in kWh — how much has been used so far this hour.',
    'Safe pace is the highest power rate that keeps this hour on track for the energy budget.',
    'kW is speed. kWh is distance.',
  ].join(' ');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'plan-hero__info';
  btn.textContent = 'ⓘ';
  btn.setAttribute('aria-label', 'Hero legend');
  setTooltip(btn, tooltip);
  return btn;
};

const buildChipRow = (
  heroStatus: HeroStatus,
  activeMode: string,
  freshnessState: FreshnessState | undefined,
  ageText: string | null,
): HTMLDivElement => {
  const row = document.createElement('div');
  row.className = 'plan-hero__chips';

  row.appendChild(buildChip(HERO_STATUS_LABEL[heroStatus], HERO_STATUS_CHIP_TONE[heroStatus]));

  if (activeMode) {
    row.appendChild(buildChip(`Mode: ${activeMode}`, 'muted'));
  }

  const freshness = formatFreshnessChip(freshnessState);
  if (freshness && freshness.kind !== 'fresh') {
    const chip = buildChip(freshness.label, freshness.tone);
    if (ageText) setTooltip(chip, `Power reading updated ${ageText}`);
    row.appendChild(chip);
  }

  row.appendChild(buildInfoButton());
  return row;
};

// ─── Power bar ────────────────────────────────────────────────────────────────

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

const pctOf = (kw: number, scaleKw: number): number =>
  Math.max(0, Math.min(100, (kw / scaleKw) * 100));

const resolveCellCount = (scaleKw: number): number => {
  const step = scaleKw <= 12 ? 1 : 2;
  return Math.max(2, Math.round(scaleKw / step));
};

const appendSegment = (container: HTMLElement, variant: string, widthPct: number): void => {
  if (widthPct <= 0) return;
  const seg = document.createElement('span');
  seg.className = `plan-hero__seg plan-hero__seg--${variant}`;
  seg.style.flexBasis = `${widthPct}%`;
  container.appendChild(seg);
};

const appendTick = (bar: HTMLElement, variant: string, offsetPct: number, tooltip: string): void => {
  const tick = document.createElement('span');
  tick.className = `plan-hero__tick plan-hero__tick--${variant}`;
  tick.style.left = `${offsetPct}%`;
  setTooltip(tick, tooltip);
  bar.appendChild(tick);
};

const buildPowerBarSegments = (scale: BarScale): HTMLDivElement => {
  const segments = document.createElement('div');
  segments.className = 'plan-hero__segments';
  segments.style.setProperty('--cell-count', String(resolveCellCount(scale.scaleKw)));
  const managedPct = pctOf(Math.min(scale.controlled, scale.total), scale.scaleKw);
  const otherPct = pctOf(
    Math.min(scale.uncontrolled, Math.max(scale.total - scale.controlled, 0)),
    scale.scaleKw,
  );
  const freePct = pctOf(Math.max(scale.safePaceKw - scale.total, 0), scale.scaleKw);
  const fillerPct = Math.max(0, 100 - managedPct - otherPct - freePct);
  appendSegment(segments, 'managed', managedPct);
  appendSegment(segments, 'other', otherPct);
  appendSegment(segments, 'free', freePct);
  appendSegment(segments, 'filler', fillerPct);
  return segments;
};

const appendOverOverlay = (bar: HTMLElement, scale: BarScale): void => {
  if (scale.total <= scale.safePaceKw) return;
  const startPct = pctOf(scale.safePaceKw, scale.scaleKw);
  const endPct = pctOf(scale.total, scale.scaleKw);
  const widthPct = Math.max(endPct - startPct, 0.5);
  const over = document.createElement('span');
  over.className = 'plan-hero__seg--over';
  over.style.left = `${startPct}%`;
  over.style.width = `${widthPct}%`;
  bar.appendChild(over);
};

const buildPowerBar = (scale: BarScale): HTMLDivElement => {
  const bar = document.createElement('div');
  bar.className = 'plan-hero__bar';
  bar.appendChild(buildPowerBarSegments(scale));
  appendOverOverlay(bar, scale);
  const safePaceTooltip = [
    `Safe pace ${scale.safePaceKw.toFixed(1)} kW —`,
    'PELS limits managed devices above this threshold.',
  ].join(' ');
  appendTick(bar, 'safe-pace', pctOf(scale.safePaceKw, scale.scaleKw), safePaceTooltip);
  if (scale.hardCapKw !== null && scale.hardCapKw > scale.safePaceKw) {
    const hardCapTooltip = [
      `Hard cap ${scale.hardCapKw.toFixed(1)} kW —`,
      'your configured maximum capacity.',
    ].join(' ');
    appendTick(bar, 'hard-cap', pctOf(scale.hardCapKw, scale.scaleKw), hardCapTooltip);
  }
  return bar;
};

const buildPowerSupportText = (scale: BarScale): HTMLDivElement => {
  const el = document.createElement('div');
  el.className = 'plan-hero__legend';

  const managedLabel = scale.controlled > 0
    ? `Managed ${scale.controlled.toFixed(1)} kW`
    : 'No managed load active';
  const loadLine = document.createElement('span');
  loadLine.className = 'plan-hero__energy-support';
  loadLine.textContent = `${managedLabel} · Other load ${scale.uncontrolled.toFixed(1)} kW`;
  el.appendChild(loadLine);

  return el;
};

// ─── Power now section ────────────────────────────────────────────────────────

const buildPowerSection = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  meta: PlanMetaSnapshot,
  hasHeldDevices: boolean,
): HTMLDivElement => {
  const section = document.createElement('div');
  section.className = 'plan-hero__section';

  const sectionLabel = document.createElement('span');
  sectionLabel.className = 'plan-hero__section-label';
  sectionLabel.textContent = 'Power now';

  const headlineEl = document.createElement('div');
  headlineEl.className = 'plan-hero__headline';
  headlineEl.textContent = `${headline.totalKw.toFixed(1)} kW now`;

  section.append(sectionLabel, headlineEl);

  if (headline.overSoftLimit) {
    const aboveKw = Math.max(0, -headline.headroomKw);
    const sublineEl = document.createElement('div');
    sublineEl.className = 'plan-hero__subline';
    sublineEl.textContent = `${aboveKw.toFixed(1)} kW above safe pace`;
    sublineEl.dataset.tone = 'warn';
    section.appendChild(sublineEl);
  } else if (hasHeldDevices) {
    const sublineEl = document.createElement('div');
    sublineEl.className = 'plan-hero__subline';
    sublineEl.textContent = `Safe pace ${headline.softLimitKw.toFixed(1)} kW`;
    section.appendChild(sublineEl);
  }

  const scale = computePowerBarScale(headline, meta);
  if (scale) {
    const barGroup = document.createElement('div');
    barGroup.className = 'plan-hero__bar-group';
    barGroup.append(buildPowerBar(scale), buildPowerSupportText(scale));
    section.appendChild(barGroup);
  }

  return section;
};

// ─── Energy bar ───────────────────────────────────────────────────────────────

type EnergyBarScale = {
  usedKWh: number;
  budgetKWh: number;
  controlledKWh: number;
  uncontrolledKWh: number;
  projectedKWh: number | null;
};

const computeEnergyBarScale = (meta: PlanMetaSnapshot): EnergyBarScale | null => {
  const { usedKWh, budgetKWh, hourControlledKWh, hourUncontrolledKWh } = meta;
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

const buildEnergyBarSegments = (scale: EnergyBarScale): HTMLDivElement => {
  const segments = document.createElement('div');
  segments.className = 'plan-hero__segments plan-hero__segments--energy';
  const managedPct = Math.max(0, Math.min(100, (scale.controlledKWh / scale.budgetKWh) * 100));
  const otherPct = Math.max(
    0,
    Math.min(100 - managedPct, (scale.uncontrolledKWh / scale.budgetKWh) * 100),
  );
  const usedPct = Math.min(100, (scale.usedKWh / scale.budgetKWh) * 100);
  const freePct = Math.max(0, 100 - usedPct);
  const fillerPct = Math.max(0, 100 - managedPct - otherPct - freePct);
  appendSegment(segments, 'managed', managedPct);
  appendSegment(segments, 'other', otherPct);
  appendSegment(segments, 'filler', fillerPct);
  appendSegment(segments, 'free', freePct);
  return segments;
};

const buildEnergyBar = (scale: EnergyBarScale): HTMLDivElement => {
  const bar = document.createElement('div');
  bar.className = 'plan-hero__bar';
  bar.appendChild(buildEnergyBarSegments(scale));
  if (scale.usedKWh > scale.budgetKWh) {
    const over = document.createElement('span');
    over.className = 'plan-hero__seg--over';
    over.style.left = '99%';
    over.style.width = '1%';
    bar.appendChild(over);
  }
  if (scale.projectedKWh !== null) {
    const projectedPct = Math.min(99, (scale.projectedKWh / scale.budgetKWh) * 100);
    const isOverBudget = scale.projectedKWh > scale.budgetKWh;
    const tooltip = isOverBudget
      ? `Projected ${scale.projectedKWh.toFixed(2)} kWh — above the hourly budget`
      : `Projected ${scale.projectedKWh.toFixed(2)} kWh this hour`;
    appendTick(bar, isOverBudget ? 'projected-over' : 'projected', projectedPct, tooltip);
  }
  return bar;
};

// ─── Energy this hour section ─────────────────────────────────────────────────

const buildEnergySection = (meta: PlanMetaSnapshot): HTMLDivElement | null => {
  const scale = computeEnergyBarScale(meta);
  if (!scale) return null;

  const section = document.createElement('div');
  section.className = 'plan-hero__section';

  const sectionLabel = document.createElement('span');
  sectionLabel.className = 'plan-hero__section-label';
  sectionLabel.textContent = 'Energy this hour';

  const usedText = `${scale.usedKWh.toFixed(2)} of ${scale.budgetKWh.toFixed(1)} kWh used`;
  let headlineText = usedText;
  if (scale.projectedKWh !== null) {
    const overWarning = scale.projectedKWh > scale.budgetKWh ? ' ⚠' : '';
    headlineText = `${usedText} · projected ${scale.projectedKWh.toFixed(2)} kWh${overWarning}`;
  }

  const headlineEl = document.createElement('div');
  headlineEl.className = 'plan-hero__headline plan-hero__headline--sm';
  headlineEl.textContent = headlineText;

  section.append(sectionLabel, headlineEl);

  const minutesRemaining = typeof meta.minutesRemaining === 'number' ? meta.minutesRemaining : null;
  if (minutesRemaining !== null) {
    const sublineEl = document.createElement('div');
    sublineEl.className = 'plan-hero__subline plan-hero__subline--muted';
    sublineEl.textContent = `${Math.round(minutesRemaining)} min left`;
    section.appendChild(sublineEl);
  }

  const barGroup = document.createElement('div');
  barGroup.className = 'plan-hero__bar-group';
  barGroup.appendChild(buildEnergyBar(scale));
  section.appendChild(barGroup);

  return section;
};

// ─── Placeholder ──────────────────────────────────────────────────────────────

const buildHeroPlaceholder = (): HTMLParagraphElement => {
  const placeholder = document.createElement('p');
  placeholder.className = 'plan-hero__placeholder muted';
  placeholder.textContent = 'Awaiting data…';
  return placeholder;
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const renderPlanHero = (
  meta: PlanMetaSnapshot | undefined,
  devices: PlanDeviceSnapshot[],
  powerStatus: SettingsUiPowerStatus | null | undefined,
  context: HeroContext,
  nowMs: number,
): void => {
  const { activeMode, dryRun } = context;
  planHero.replaceChildren();
  planHero.removeAttribute('data-tone');

  const headline = formatHeroHeadline(meta, nowMs);
  if (!headline || !meta) {
    planHero.appendChild(buildHeroPlaceholder());
    return;
  }

  const freshnessState = resolveFreshnessState(powerStatus, meta);
  const heroStatus = resolveHeroStatus(headline, devices, freshnessState, dryRun);

  planHero.dataset.tone = HERO_STATUS_DATA_TONE[heroStatus];

  const hasHeldDevices = devices.some((d) => d.stateKind === 'held');

  planHero.appendChild(buildChipRow(heroStatus, activeMode, freshnessState, headline.ageText));
  planHero.appendChild(buildPowerSection(headline, meta, hasHeldDevices));

  const energySection = buildEnergySection(meta);
  if (energySection) planHero.appendChild(energySection);

  const { text: decisionText, positive } = buildDecisionSentence(headline, devices, freshnessState, dryRun);
  const decision = document.createElement('p');
  decision.className = 'plan-hero__decision';
  decision.textContent = positive ? `✓ ${decisionText}` : decisionText;
  if (positive) decision.dataset.positive = '';
  planHero.appendChild(decision);
};

export const renderPlanHourStrip = (_meta: PlanMetaSnapshot | undefined): void => {
  planHourStrip.hidden = true;
};
