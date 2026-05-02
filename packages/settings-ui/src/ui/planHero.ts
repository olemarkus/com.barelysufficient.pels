import { planHero, planHourStrip } from './dom.ts';
import {
  formatFreshnessChip,
  formatHeroHeadline,
} from '../../../shared-domain/src/planHeroSummary.ts';
import { summarizeStarvation } from '../../../shared-domain/src/planStarvation.ts';
import { summarizeCooldowns } from '../../../shared-domain/src/planCooldown.ts';
import { setTooltip } from './tooltips.ts';
import type { SettingsUiPowerStatus } from '../../../contracts/src/settingsUiApi.ts';
import type { PlanDeviceSnapshot, PlanMetaSnapshot } from './planTypes.ts';

type FreshnessState = NonNullable<SettingsUiPowerStatus['powerFreshnessState']>;

const resolveFreshnessState = (
  powerStatus: SettingsUiPowerStatus | null | undefined,
  meta: PlanMetaSnapshot,
): FreshnessState | undefined => {
  const fromPower = powerStatus?.powerFreshnessState;
  if (fromPower) return fromPower;
  return meta.powerFreshnessState;
};

const buildHeroPlaceholder = (): HTMLParagraphElement => {
  const placeholder = document.createElement('p');
  placeholder.className = 'plan-hero__placeholder muted';
  placeholder.textContent = 'Awaiting data…';
  return placeholder;
};

// ─── Bar scale ────────────────────────────────────────────────────────────────

type BarScale = {
  total: number;
  controlled: number;
  uncontrolled: number;
  pelsKw: number;
  gridKw: number | null;
  scaleKw: number;
};

const computePowerBarScale = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  meta: PlanMetaSnapshot,
): BarScale | null => {
  const pelsKw = meta.softLimitKw ?? meta.capacitySoftLimitKw ?? 0;
  if (pelsKw <= 0) return null;
  const total = Math.max(0, headline.totalKw ?? 0);
  const controlled = Math.max(0, headline.controlledKw ?? 0);
  const uncontrolled = Math.max(0, headline.uncontrolledKw ?? 0);
  const gridKw = headline.hardLimitKw ?? null;
  const scaleKw = Math.max(pelsKw * 1.2, gridKw ?? 0, total * 1.05);
  return { total, controlled, uncontrolled, pelsKw, gridKw, scaleKw };
};

const pctOf = (kw: number, scaleKw: number): number =>
  Math.max(0, Math.min(100, (kw / scaleKw) * 100));

const resolveCellCount = (scaleKw: number): number => {
  const step = scaleKw <= 12 ? 1 : 2;
  return Math.max(2, Math.round(scaleKw / step));
};

// ─── Power bar ────────────────────────────────────────────────────────────────

const appendSegment = (container: HTMLElement, variant: string, widthPct: number): void => {
  if (widthPct <= 0) return;
  const seg = document.createElement('span');
  seg.className = `plan-hero__seg plan-hero__seg--${variant}`;
  seg.style.flexBasis = `${widthPct}%`;
  container.appendChild(seg);
};

const appendTick = (
  bar: HTMLElement,
  variant: string,
  offsetPct: number,
  tooltip: string,
): void => {
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
  const freePct = pctOf(Math.max(scale.pelsKw - scale.total, 0), scale.scaleKw);
  const fillerPct = Math.max(0, 100 - managedPct - otherPct - freePct);
  appendSegment(segments, 'managed', managedPct);
  appendSegment(segments, 'other', otherPct);
  appendSegment(segments, 'free', freePct);
  appendSegment(segments, 'filler', fillerPct);
  return segments;
};

const appendOverOverlay = (bar: HTMLElement, scale: BarScale): void => {
  if (scale.total <= scale.pelsKw) return;
  const startPct = pctOf(scale.pelsKw, scale.scaleKw);
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
  appendTick(
    bar,
    'pels',
    pctOf(scale.pelsKw, scale.scaleKw),
    `PELS limit ${scale.pelsKw.toFixed(1)} kW — PELS sheds managed devices above this threshold`,
  );
  if (scale.gridKw !== null && scale.gridKw > scale.pelsKw) {
    appendTick(
      bar,
      'grid',
      pctOf(scale.gridKw, scale.scaleKw),
      `Hard cap ${scale.gridKw.toFixed(1)} kW — your configured maximum capacity`,
    );
  }
  return bar;
};

const buildPowerInfoButton = (scale: BarScale): HTMLButtonElement => {
  const managedText = [
    'Managed load — devices PELS controls (heaters, EV chargers, water tanks).',
    `Currently ${scale.controlled.toFixed(1)} kW.`,
  ].join(' ');
  const otherText = [
    'Other load — household usage PELS cannot shed (always-on appliances, lights, cooking, etc.).',
    `Currently ${scale.uncontrolled.toFixed(1)} kW.`,
  ].join(' ');
  const pelsText = [
    'PELS limit — where PELS starts shedding',
    '(your capacity limit minus margin, adjusted for energy used so far this hour).',
    `Currently ${scale.pelsKw.toFixed(1)} kW.`,
  ].join(' ');
  const gridText = scale.gridKw !== null
    ? [
        ' Hard cap — your configured maximum capacity',
        `(${scale.gridKw.toFixed(1)} kW).`,
        'Exceeding this may trigger tariff penalties or trip breakers.',
      ].join(' ')
    : '';
  const tooltip = `${managedText} ${otherText} ${pelsText}${gridText}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'plan-hero__info';
  btn.textContent = 'ⓘ';
  btn.setAttribute('aria-label', 'Power bar legend');
  setTooltip(btn, tooltip);
  return btn;
};

const buildPowerLegend = (scale: BarScale): HTMLDivElement => {
  const legend = document.createElement('div');
  legend.className = 'plan-hero__legend';
  const items: Array<{ variant: string; label: string }> = [
    { variant: 'managed', label: `Managed ${scale.controlled.toFixed(1)} kW` },
    { variant: 'other', label: `Other ${scale.uncontrolled.toFixed(1)} kW` },
    { variant: 'pels', label: `PELS limit ${scale.pelsKw.toFixed(1)} kW` },
  ];
  if (scale.gridKw !== null) {
    items.push({ variant: 'grid', label: `Hard cap ${scale.gridKw.toFixed(1)} kW` });
  }
  for (const item of items) {
    const wrap = document.createElement('span');
    wrap.className = 'plan-hero__legend-item';
    const swatch = document.createElement('span');
    swatch.className = `plan-hero__legend-swatch plan-hero__legend-swatch--${item.variant}`;
    const text = document.createElement('span');
    text.textContent = item.label;
    wrap.append(swatch, text);
    legend.appendChild(wrap);
  }
  return legend;
};

const buildBarHeader = (
  eyebrow: string,
  value: string,
  infoButton?: HTMLElement,
): HTMLDivElement => {
  const header = document.createElement('div');
  header.className = 'plan-hero__bar-header';
  const eyebrowEl = document.createElement('span');
  eyebrowEl.className = 'plan-hero__bar-eyebrow';
  eyebrowEl.textContent = eyebrow;
  const valueEl = document.createElement('span');
  valueEl.className = 'plan-hero__bar-value';
  valueEl.textContent = value;
  header.append(eyebrowEl, valueEl);
  if (infoButton) header.appendChild(infoButton);
  return header;
};

const buildPowerBarGroup = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  meta: PlanMetaSnapshot,
): HTMLDivElement | null => {
  const scale = computePowerBarScale(headline, meta);
  if (!scale) return null;
  const group = document.createElement('div');
  group.className = 'plan-hero__bar-group';
  const header = buildBarHeader(
    'Now',
    `${headline.totalKw.toFixed(1)} kW`,
    buildPowerInfoButton(scale),
  );
  group.append(header, buildPowerBar(scale), buildPowerLegend(scale));
  return group;
};

// ─── Energy bar ───────────────────────────────────────────────────────────────

type EnergyBarScale = {
  usedKWh: number;
  budgetKWh: number;
  controlledKWh: number;
  uncontrolledKWh: number;
};

const computeEnergyBarScale = (meta: PlanMetaSnapshot): EnergyBarScale | null => {
  const { usedKWh, budgetKWh, hourControlledKWh, hourUncontrolledKWh } = meta;
  if (
    typeof usedKWh !== 'number'
    || typeof budgetKWh !== 'number'
    || budgetKWh <= 0
  ) return null;
  return {
    usedKWh,
    budgetKWh,
    controlledKWh: typeof hourControlledKWh === 'number' ? Math.max(0, hourControlledKWh) : 0,
    uncontrolledKWh: typeof hourUncontrolledKWh === 'number' ? Math.max(0, hourUncontrolledKWh) : 0,
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
  return bar;
};

const buildEnergyBarGroup = (meta: PlanMetaSnapshot): HTMLDivElement | null => {
  const scale = computeEnergyBarScale(meta);
  if (!scale) return null;
  const group = document.createElement('div');
  group.className = 'plan-hero__bar-group';
  const valueText = `${scale.usedKWh.toFixed(2)} of ${scale.budgetKWh.toFixed(1)} kWh`;
  group.append(buildBarHeader('This hour', valueText), buildEnergyBar(scale));
  return group;
};

// ─── Status chips ─────────────────────────────────────────────────────────────

const buildStatusBlock = (
  headline: NonNullable<ReturnType<typeof formatHeroHeadline>>,
  meta: PlanMetaSnapshot,
  devices: PlanDeviceSnapshot[],
  powerStatus: SettingsUiPowerStatus | null | undefined,
): HTMLDivElement | null => {
  const status = document.createElement('div');
  status.className = 'plan-hero__status';

  const freshness = formatFreshnessChip(resolveFreshnessState(powerStatus, meta));
  if (freshness && freshness.kind !== 'fresh') {
    const chip = document.createElement('span');
    chip.className = `plan-chip plan-chip--${freshness.tone}`;
    chip.textContent = freshness.label;
    if (headline.ageText) setTooltip(chip, `Power reading updated ${headline.ageText}`);
    status.appendChild(chip);
  }

  const starvationLabel = summarizeStarvation(devices);
  if (starvationLabel) {
    const chip = document.createElement('span');
    chip.className = 'plan-chip plan-chip--muted';
    chip.textContent = starvationLabel;
    status.appendChild(chip);
  }

  const cooldownLabel = summarizeCooldowns(devices);
  if (cooldownLabel) {
    const chip = document.createElement('span');
    chip.className = 'plan-chip plan-chip--muted';
    chip.textContent = cooldownLabel;
    status.appendChild(chip);
  }

  return status.childElementCount > 0 ? status : null;
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const renderPlanHero = (
  meta: PlanMetaSnapshot | undefined,
  devices: PlanDeviceSnapshot[],
  powerStatus: SettingsUiPowerStatus | null | undefined,
  nowMs: number,
): void => {
  planHero.replaceChildren();
  planHero.removeAttribute('data-tone');

  const headline = formatHeroHeadline(meta, nowMs);
  if (!headline || !meta) {
    planHero.appendChild(buildHeroPlaceholder());
    return;
  }

  planHero.dataset.tone = headline.tone;

  const powerBarGroup = buildPowerBarGroup(headline, meta);
  if (powerBarGroup) planHero.appendChild(powerBarGroup);

  const energyBarGroup = buildEnergyBarGroup(meta);
  if (energyBarGroup) planHero.appendChild(energyBarGroup);

  const status = buildStatusBlock(headline, meta, devices, powerStatus);
  if (status) planHero.appendChild(status);
};

export const renderPlanHourStrip = (_meta: PlanMetaSnapshot | undefined): void => {
  // Hour strip consolidated into the hero; keep element hidden.
  planHourStrip.hidden = true;
};
