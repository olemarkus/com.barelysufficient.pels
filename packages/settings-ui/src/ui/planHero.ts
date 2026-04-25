import { planHero, planHourStrip } from './dom.ts';
import { createUsageBar } from './components.ts';
import {
  formatFreshnessChip,
  formatHeroHeadline,
} from '../../../shared-domain/src/planHeroSummary.ts';
import { formatHourStripLabel } from '../../../shared-domain/src/planHourStrip.ts';
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

const appendTextElement = (
  parent: HTMLElement,
  className: string,
  text: string,
  tag: keyof HTMLElementTagNameMap = 'p',
): HTMLElement => {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
};

type Headline = NonNullable<ReturnType<typeof formatHeroHeadline>>;

const buildHeroPlaceholder = (): HTMLParagraphElement => {
  const placeholder = document.createElement('p');
  placeholder.className = 'plan-hero__placeholder muted';
  placeholder.textContent = 'Awaiting data…';
  return placeholder;
};

const buildHeroInfoButton = (tooltipText: string): HTMLButtonElement => {
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'plan-hero__info';
  info.textContent = 'ⓘ';
  info.setAttribute('aria-label', 'Load bar legend');
  setTooltip(info, tooltipText);
  return info;
};

const buildHeadlineRow = (headline: Headline): HTMLDivElement => {
  const headlineRow = document.createElement('div');
  headlineRow.className = 'plan-hero__headline-row';
  const total = document.createElement('h2');
  total.className = 'plan-hero__value';
  total.textContent = headline.kwText;
  const limit = document.createElement('p');
  limit.className = 'plan-hero__limit';
  limit.textContent = headline.limitText;
  headlineRow.append(total, limit);
  return headlineRow;
};

const buildStatusBlock = (
  headline: Headline,
  meta: PlanMetaSnapshot,
  devices: PlanDeviceSnapshot[],
  powerStatus: SettingsUiPowerStatus | null | undefined,
): HTMLDivElement | null => {
  const status = document.createElement('div');
  status.className = 'plan-hero__status';
  const freshness = formatFreshnessChip(resolveFreshnessState(powerStatus, meta));
  if (freshness) {
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

const buildHeroHeading = (headline: Headline): HTMLDivElement => {
  const heading = document.createElement('div');
  heading.className = 'plan-hero__heading';
  heading.appendChild(buildHeadlineRow(headline));
  appendTextElement(heading, 'plan-hero__message', headline.message);
  return heading;
};

type BarScale = {
  total: number;
  controlled: number;
  uncontrolled: number;
  softKw: number;
  hardKw: number | null;
  scaleKw: number;
};

const computeBarScale = (headline: Headline, meta: PlanMetaSnapshot): BarScale | null => {
  const softKw = meta.softLimitKw ?? meta.capacitySoftLimitKw ?? 0;
  if (softKw <= 0) return null;
  const total = Math.max(0, headline.totalKw ?? 0);
  const controlled = Math.max(0, headline.controlledKw ?? 0);
  const uncontrolled = Math.max(0, headline.uncontrolledKw ?? 0);
  const hardKw = headline.hardLimitKw ?? null;
  const scaleKw = Math.max(softKw * 1.2, hardKw ?? 0, total * 1.05);
  return { total, controlled, uncontrolled, softKw, hardKw, scaleKw };
};

const describeHeroBarScale = (scale: BarScale): string => {
  const hardLimitText = scale.hardKw !== null
    ? ` Yellow marker is the hard limit at ${scale.hardKw.toFixed(1)} kW.`
    : '';
  const managedText = `green is managed load (${scale.controlled.toFixed(1)} kW)`;
  const otherText = `blue is other load (${scale.uncontrolled.toFixed(1)} kW)`;
  const softText = `White marker is the soft limit at ${scale.softKw.toFixed(1)} kW.`;
  const headroomText = 'dark space is headroom before the soft limit.';
  return `Load bar: ${managedText}, ${otherText}, and ${headroomText} ${softText}${hardLimitText}`;
};

const resolveHeroBarTooltip = (headline: Headline, meta: PlanMetaSnapshot): string | null => {
  const scale = computeBarScale(headline, meta);
  return scale ? describeHeroBarScale(scale) : null;
};

const pctOf = (kw: number, scaleKw: number): number => Math.max(0, Math.min(100, (kw / scaleKw) * 100));

const appendSegment = (segments: HTMLElement, variant: string, widthPct: number): void => {
  if (widthPct <= 0) return;
  const seg = document.createElement('span');
  seg.className = `plan-hero__seg plan-hero__seg--${variant}`;
  seg.style.flexBasis = `${widthPct}%`;
  segments.appendChild(seg);
};

const appendTick = (bar: HTMLElement, variant: string, offsetPct: number, tooltip: string): void => {
  const tick = document.createElement('span');
  tick.className = `plan-hero__tick plan-hero__tick--${variant}`;
  tick.style.left = `${offsetPct}%`;
  setTooltip(tick, tooltip);
  bar.appendChild(tick);
};

const buildBarSegments = (scale: BarScale): HTMLDivElement => {
  const segments = document.createElement('div');
  segments.className = 'plan-hero__segments';
  const managedPct = pctOf(Math.min(scale.controlled, scale.total), scale.scaleKw);
  const otherPct = pctOf(Math.min(scale.uncontrolled, Math.max(scale.total - scale.controlled, 0)), scale.scaleKw);
  const freePct = pctOf(Math.max(scale.softKw - scale.total, 0), scale.scaleKw);
  const fillerPct = Math.max(0, 100 - managedPct - otherPct - freePct);
  appendSegment(segments, 'managed', managedPct);
  appendSegment(segments, 'other', otherPct);
  appendSegment(segments, 'free', freePct);
  appendSegment(segments, 'filler', fillerPct);
  return segments;
};

const appendOverOverlay = (bar: HTMLElement, scale: BarScale): void => {
  if (scale.total <= scale.softKw) return;
  const startPct = pctOf(scale.softKw, scale.scaleKw);
  const endPct = pctOf(scale.total, scale.scaleKw);
  const widthPct = Math.max(endPct - startPct, 0.5);
  const over = document.createElement('span');
  over.className = 'plan-hero__seg--over';
  over.style.left = `${startPct}%`;
  over.style.width = `${widthPct}%`;
  bar.appendChild(over);
};

const buildHeroBar = (headline: Headline, meta: PlanMetaSnapshot): HTMLDivElement | null => {
  const scale = computeBarScale(headline, meta);
  if (!scale) return null;

  const wrap = document.createElement('div');
  wrap.className = 'plan-hero__bar-wrap';

  const bar = document.createElement('div');
  bar.className = 'plan-hero__bar';
  const segments = buildBarSegments(scale);
  bar.appendChild(segments);
  appendOverOverlay(bar, scale);
  const softPct = pctOf(scale.softKw, scale.scaleKw);
  appendTick(bar, 'soft', softPct, `Soft limit ${scale.softKw.toFixed(1)} kW — PELS sheds devices above this`);
  const hardPct = scale.hardKw !== null && scale.hardKw > scale.softKw
    ? pctOf(scale.hardKw, scale.scaleKw)
    : null;
  if (scale.hardKw !== null && hardPct !== null) {
    appendTick(bar, 'hard', hardPct, `Hard limit ${scale.hardKw.toFixed(1)} kW — breaker safety cap`);
  }
  wrap.appendChild(bar);
  return wrap;
};

const buildHeroNote = (meta: PlanMetaSnapshot, headline: Headline): HTMLParagraphElement | null => {
  if (headline.overHardLimit && typeof meta.hardCapHeadroomKw === 'number') {
    const note = document.createElement('p');
    note.className = 'plan-hero__note';
    note.dataset.tone = 'alert';
    note.textContent = `Hard limit breached by ${Math.abs(meta.hardCapHeadroomKw).toFixed(1)} kW`;
    return note;
  }
  if (headline.overSoftLimit && typeof meta.hardCapHeadroomKw === 'number') {
    const note = document.createElement('p');
    note.className = 'plan-hero__note';
    note.dataset.tone = 'warn';
    note.textContent = `${meta.hardCapHeadroomKw.toFixed(1)} kW before hard limit`;
    return note;
  }
  return null;
};

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
  const barTooltipText = resolveHeroBarTooltip(headline, meta);

  const top = document.createElement('div');
  top.className = 'plan-hero__top';
  if (barTooltipText) top.appendChild(buildHeroInfoButton(barTooltipText));
  top.appendChild(buildHeroHeading(headline));
  const status = buildStatusBlock(headline, meta, devices, powerStatus);
  if (status) top.appendChild(status);
  planHero.appendChild(top);

  const bar = buildHeroBar(headline, meta);
  if (bar) planHero.appendChild(bar);

  const note = buildHeroNote(meta, headline);
  if (note) planHero.appendChild(note);
};

export const renderPlanHourStrip = (meta: PlanMetaSnapshot | undefined): void => {
  const view = formatHourStripLabel(meta);
  const hasContent = Boolean(view.primary || view.secondary || view.endsInMin !== null);
  planHourStrip.hidden = !hasContent;
  planHourStrip.replaceChildren();
  if (view.secondary) {
    planHourStrip.dataset.tone = 'limited';
  } else {
    planHourStrip.removeAttribute('data-tone');
  }
  if (!hasContent) return;

  const header = document.createElement('div');
  header.className = 'plan-hour-strip__header';

  const copy = document.createElement('div');
  copy.className = 'plan-hour-strip__copy';
  appendTextElement(copy, 'plan-hour-strip__eyebrow', 'This hour');
  if (view.primary) appendTextElement(copy, 'plan-hour-strip__primary', view.primary);
  if (view.secondary) appendTextElement(copy, 'plan-hour-strip__secondary', view.secondary);
  header.appendChild(copy);

  if (view.endsInMin !== null) {
    const chip = document.createElement('span');
    chip.className = 'plan-chip plan-chip--warn';
    chip.textContent = `Ends in ${view.endsInMin} min`;
    header.appendChild(chip);
  }

  planHourStrip.appendChild(header);

  if (view.usedFraction !== null) {
    const bar = createUsageBar({
      value: view.usedFraction,
      max: 1,
      minFillPct: view.usedFraction > 0 ? 6 : 0,
      className: 'plan-hour-strip__bar',
      fillClassName: `plan-hour-strip__fill ${view.usedFraction >= 1 ? 'plan-hour-strip__fill--warn' : ''}`.trim(),
      title: view.primary ?? undefined,
    });
    planHourStrip.appendChild(bar);
  }
};
