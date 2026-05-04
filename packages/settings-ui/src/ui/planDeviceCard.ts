import { formatDeviceOverview } from '../../../shared-domain/src/deviceOverview.ts';
import { PLAN_REASON_CODES } from '../../../shared-domain/src/planReasonSemanticsCore.ts';
import {
  PLAN_STATE_LABEL,
  PLAN_STATE_TONE,
  type PlanStateKind,
  resolvePlanStateKind,
} from '../../../shared-domain/src/planStateLabels.ts';
// Keep overview chip copy in shared-domain instead of maintaining a parallel UI-only label map.
import {
  formatStarvationBadge,
  formatStarvationReason,
} from '../../../shared-domain/src/planStarvation.ts';
import {
  resolveTemperatureOutputState,
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../../shared-domain/src/planTemperatureCardText.ts';
import {
  resolveCooldownBaseSec,
  resolveCooldownRemainingSec,
} from '../../../shared-domain/src/planCooldown.ts';
import { setTooltip } from './tooltips.ts';
import { resolveDisplayPlanDeviceSnapshot } from './planLiveData.ts';
import { formatReasonSummary } from './planReasonSummary.ts';
import { buildSteppedPlanCard } from './planSteppedCard.ts';
import type { PlanDeviceSnapshot, PlanSnapshot, PlanStatusBinding } from './planTypes.ts';
import type { DeviceReason } from '../../../shared-domain/src/planReasonSemanticsCore.ts';

const formatKw = (value: number | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '–'
);

const isPlanStateKind = (value: string | undefined): value is PlanStateKind => (
  value === 'active'
  || value === 'idle'
  || value === 'held'
  || value === 'resuming'
  || value === 'manual'
  || value === 'unavailable'
  || value === 'unknown'
);

const resolveStatePresentation = (dev: PlanDeviceSnapshot) => {
  const kind = isPlanStateKind(dev.stateKind) ? dev.stateKind : resolvePlanStateKind(dev);
  return {
    kind,
    label: PLAN_STATE_LABEL[kind],
    tone: dev.stateTone ?? PLAN_STATE_TONE[kind],
  };
};

type CooldownProgressElement = HTMLElement & { value?: number; indeterminate?: boolean };

const applyCooldownProgress = (
  progress: CooldownProgressElement,
  remainingSec: number | null,
  baseSec: number | null,
): void => {
  if (baseSec === null || remainingSec === null || remainingSec <= 0) {
    // eslint-disable-next-line no-param-reassign
    progress.hidden = true;
    return;
  }
  const ratio = Math.max(0, Math.min(1, remainingSec / Math.max(1, baseSec)));
  // eslint-disable-next-line no-param-reassign
  progress.hidden = false;
  // eslint-disable-next-line no-param-reassign
  progress.value = ratio;
  progress.setAttribute('value', `${ratio}`);
  setTooltip(progress, `${Math.round(remainingSec)}s remaining`);
};

const buildCooldownProgress = (tone: string): CooldownProgressElement => {
  const progress = document.createElement('md-circular-progress') as CooldownProgressElement;
  progress.className = 'plan-state-chip__timer';
  progress.dataset.tone = tone;
  progress.setAttribute('aria-hidden', 'true');
  progress.hidden = true;
  return progress;
};

const buildStateChip = (dev: PlanDeviceSnapshot): {
  wrap: HTMLElement;
  chipEl: HTMLElement;
  progressEl: CooldownProgressElement;
} => {
  const presentation = resolveStatePresentation(dev);
  const remainingSec = resolveCooldownRemainingSec(dev);
  const baseSec = resolveCooldownBaseSec(dev);

  const wrap = document.createElement('span');
  wrap.className = 'plan-state-chip-wrap';

  const chip = document.createElement('span');
  chip.className = `plan-state-chip plan-state-chip--${presentation.tone}`;
  chip.textContent = presentation.label;
  chip.dataset.stateKind = presentation.kind;
  chip.setAttribute('role', 'img');
  chip.setAttribute('aria-label', presentation.label);
  setTooltip(chip, presentation.label);

  const progress = buildCooldownProgress(presentation.tone);
  applyCooldownProgress(progress, remainingSec, baseSec);

  wrap.append(chip, progress);
  return { wrap, chipEl: chip, progressEl: progress };
};

const buildInlineChip = (className: string, text: string, tooltip?: string): HTMLSpanElement => {
  const chip = document.createElement('span');
  chip.className = className;
  chip.textContent = text;
  if (tooltip) setTooltip(chip, tooltip);
  return chip;
};

const isTrivialReason = (reason: unknown): boolean => {
  if (!reason || typeof reason !== 'object') return false;
  const code = (reason as { code?: unknown }).code;
  if (code === PLAN_REASON_CODES.none) return true;
  if (code === PLAN_REASON_CODES.keep) {
    const detail = (reason as { detail?: unknown }).detail;
    return detail === null || detail === undefined || detail === '';
  }
  return false;
};

const isDeviceReason = (reason: unknown): reason is DeviceReason => (
  Boolean(reason)
  && typeof reason === 'object'
  && typeof (reason as { code?: unknown }).code === 'string'
);


const resolveReasonText = (dev: PlanDeviceSnapshot): string => {
  if (dev.starvation?.isStarved && dev.starvation.cause === 'capacity') {
    const override = formatStarvationReason(dev.starvation);
    if (override) return override;
  }
  if (isTrivialReason(dev.reason)) return '';
  if (isDeviceReason(dev.reason)) return formatReasonSummary(dev.reason);
  return formatDeviceOverview(dev).statusMsg;
};

type PowerReadout = { text: string; variant: 'live' | 'expected' };

const isDrawing = (dev: PlanDeviceSnapshot): boolean => (
  dev.currentState === 'on'
  && typeof dev.measuredPowerKw === 'number'
  && dev.measuredPowerKw > 0.05
);

const resolveExpectedKw = (dev: PlanDeviceSnapshot): number | null => {
  const candidates = [dev.planningPowerKw, dev.expectedPowerKw];
  for (const value of candidates) {
    if (typeof value === 'number' && value > 0.05) return value;
  }
  return null;
};

const resolvePowerReadout = (dev: PlanDeviceSnapshot): PowerReadout | null => {
  if (isDrawing(dev)) {
    return { text: `${formatKw(dev.measuredPowerKw)} kW`, variant: 'live' };
  }
  const expected = resolveExpectedKw(dev);
  if (expected !== null) {
    return { text: `~${expected.toFixed(1)} kW when active`, variant: 'expected' };
  }
  return null;
};

const buildPowerRow = (dev: PlanDeviceSnapshot): HTMLElement | null => {
  const readout = resolvePowerReadout(dev);
  if (!readout) return null;
  const row = document.createElement('div');
  row.className = 'plan-card__metric plan-card__metric--power';
  row.dataset.variant = readout.variant;
  const label = document.createElement('span');
  label.className = 'plan-card__metric-label';
  label.textContent = readout.text;
  row.appendChild(label);
  return row;
};

const buildMetricRow = (dev: PlanDeviceSnapshot): HTMLElement | null => buildPowerRow(dev);

const dispatchOpenDeviceDetail = (deviceId: string): void => {
  document.dispatchEvent(new CustomEvent('open-device-detail', { detail: { deviceId } }));
};

const attachCardActivation = (card: HTMLElement, deviceId: string): void => {
  card.addEventListener('click', () => {
    dispatchOpenDeviceDetail(deviceId);
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === ' ') event.preventDefault();
    if (event.key !== 'Enter') return;
    event.preventDefault();
    dispatchOpenDeviceDetail(deviceId);
  });
  card.addEventListener('keyup', (event) => {
    if (event.key !== ' ') return;
    event.preventDefault();
    dispatchOpenDeviceDetail(deviceId);
  });
};

export const updatePlanCardBinding = (
  binding: PlanStatusBinding,
  plan: PlanSnapshot | null,
  renderedAtMs: number,
  nowMs: number,
): void => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(plan, binding.device, renderedAtMs, nowMs);
  const reasonText = resolveReasonText(displayDev);
  // eslint-disable-next-line no-param-reassign
  binding.reasonEl.textContent = reasonText;
  // eslint-disable-next-line no-param-reassign
  binding.reasonEl.hidden = reasonText === '';

  const remainingSec = resolveCooldownRemainingSec(displayDev);
  const baseSec = resolveCooldownBaseSec(displayDev);
  if (binding.chipEl) {
    const presentation = resolveStatePresentation(displayDev);
    // eslint-disable-next-line no-param-reassign
    binding.chipEl.textContent = presentation.label;
  }
  if (binding.cooldownProgressEl) {
    applyCooldownProgress(binding.cooldownProgressEl as CooldownProgressElement, remainingSec, baseSec);
  }
};

const buildHeader = (dev: PlanDeviceSnapshot): {
  el: HTMLElement;
  chip: HTMLElement;
  cooldownProgress: HTMLElement;
} => {
  const header = document.createElement('div');
  header.className = 'plan-card__header';

  const nameWrap = document.createElement('div');
  nameWrap.className = 'plan-card__title-wrap';
  const title = document.createElement('h3');
  title.className = 'plan-card__title';
  title.textContent = dev.name;
  nameWrap.appendChild(title);
  header.appendChild(nameWrap);

  const chips = document.createElement('div');
  chips.className = 'plan-card__chips';
  const stateChip = buildStateChip(dev);
  chips.appendChild(stateChip.wrap);
  if (dev.budgetExempt === true) {
    chips.appendChild(buildInlineChip('plan-chip plan-chip--muted', 'Always on'));
  }
  const starvationBadge = formatStarvationBadge(dev.starvation);
  if (starvationBadge) {
    chips.appendChild(buildInlineChip(
      `plan-chip plan-chip--${starvationBadge.tone}`,
      starvationBadge.label,
      starvationBadge.tooltip,
    ));
  }
  header.appendChild(chips);
  return { el: header, chip: stateChip.chipEl, cooldownProgress: stateChip.progressEl };
};

const buildGenericPlanCard = (
  plan: PlanSnapshot | null,
  dev: PlanDeviceSnapshot,
  renderedAtMs: number,
  nowMs: number,
): { el: HTMLElement; statusBinding: PlanStatusBinding } => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(plan, dev, renderedAtMs, nowMs);
  const presentation = resolveStatePresentation(displayDev);

  const card = document.createElement('article');
  card.className = 'device-row plan-card clickable';
  card.dataset.deviceId = dev.id;
  card.dataset.stateKind = presentation.kind;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open device details for ${dev.name}`);
  if (presentation.kind === 'idle' || presentation.kind === 'manual') {
    card.classList.add('plan-card--dim');
  }
  if (presentation.kind === 'unavailable') {
    card.classList.add('plan-card--unavailable');
  }

  const elevation = document.createElement('md-elevation');
  elevation.setAttribute('aria-hidden', 'true');
  const ripple = document.createElement('md-ripple');
  ripple.setAttribute('aria-hidden', 'true');
  card.append(elevation, ripple);

  const header = buildHeader(displayDev);
  const metric = buildMetricRow(displayDev);
  const reasonText = resolveReasonText(displayDev);
  const reason = document.createElement('p');
  reason.className = 'plan-card__reason';
  reason.textContent = reasonText;
  reason.hidden = reasonText === '';

  card.appendChild(header.el);
  if (metric) card.appendChild(metric);
  card.appendChild(reason);
  attachCardActivation(card, dev.id);

  return {
    el: card,
    statusBinding: {
      device: dev,
      reasonEl: reason,
      chipEl: header.chip,
      cooldownProgressEl: header.cooldownProgress,
    },
  };
};

// ─── Temperature card ─────────────────────────────────────────────────────────

const buildHidableText = (className: string, text: string | null): HTMLElement => {
  const el = document.createElement('p');
  el.className = className;
  el.textContent = text ?? '';
  el.style.visibility = text === null ? 'hidden' : '';
  return el;
};

const buildTemperatureOutputRow = (dev: PlanDeviceSnapshot): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'plan-card__output-row';
  const state = document.createElement('span');
  state.className = 'plan-card__output-state';
  state.textContent = resolveTemperatureOutputState(dev);
  const power = document.createElement('span');
  power.className = 'plan-card__output-power';
  power.textContent = `${formatKw(dev.measuredPowerKw)} kW`;
  row.append(state, power);
  return row;
};

const buildTemperatureHeader = (dev: PlanDeviceSnapshot): HTMLElement => {
  const header = document.createElement('div');
  header.className = 'plan-card__header';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'plan-card__title-wrap';
  const title = document.createElement('h3');
  title.className = 'plan-card__title';
  title.textContent = dev.name;
  nameWrap.appendChild(title);
  header.appendChild(nameWrap);

  const chips = document.createElement('div');
  chips.className = 'plan-card__chips';
  if (dev.temperatureBoostActive === true) {
    chips.appendChild(buildInlineChip('plan-chip plan-chip--ok', 'Boost', 'Temperature boost is active'));
  }
  const starvationBadge = formatStarvationBadge(dev.starvation);
  if (starvationBadge) {
    chips.appendChild(buildInlineChip(
      `plan-chip plan-chip--${starvationBadge.tone}`,
      starvationBadge.label,
      starvationBadge.tooltip,
    ));
  }
  header.appendChild(chips);
  return header;
};

const buildTemperatureCard = (
  plan: PlanSnapshot | null, dev: PlanDeviceSnapshot, renderedAtMs: number, nowMs: number,
): { el: HTMLElement; statusBinding: PlanStatusBinding } => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(plan, dev, renderedAtMs, nowMs);
  const kind = resolvePlanStateKind(displayDev) as PlanStateKind;

  const card = document.createElement('article');
  card.className = 'device-row plan-card plan-card--temperature clickable';
  card.dataset.deviceId = dev.id;
  card.dataset.stateKind = kind;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open device details for ${dev.name}`);
  if (kind === 'idle') card.classList.add('plan-card--dim');
  if (kind === 'unavailable') card.classList.add('plan-card--unavailable');
  const elevation = document.createElement('md-elevation');
  elevation.setAttribute('aria-hidden', 'true');
  const ripple = document.createElement('md-ripple');
  ripple.setAttribute('aria-hidden', 'true');
  card.append(elevation, ripple);

  const reasonEl = buildHidableText('plan-card__temp-reason', resolveTemperatureReasonLine(displayDev));
  card.append(
    buildTemperatureHeader(displayDev),
    buildTemperatureOutputRow(displayDev),
    buildHidableText('plan-card__temp-line', resolveTemperatureLine(displayDev)),
    reasonEl,
  );
  attachCardActivation(card, dev.id);
  return {
    el: card,
    statusBinding: { device: dev, reasonEl, chipEl: null, cooldownProgressEl: null },
  };
};

export const buildPlanCard = (
  plan: PlanSnapshot | null,
  dev: PlanDeviceSnapshot,
  renderedAtMs: number,
  nowMs: number,
): { el: HTMLElement; statusBinding: PlanStatusBinding } => {
  if (dev.controlModel === 'stepped_load') return buildSteppedPlanCard(plan, dev, renderedAtMs, nowMs);
  if (dev.controlModel === 'temperature_target') return buildTemperatureCard(plan, dev, renderedAtMs, nowMs);
  return buildGenericPlanCard(plan, dev, renderedAtMs, nowMs);
};
