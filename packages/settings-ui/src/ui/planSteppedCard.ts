import {
  capitalizeStepLabel,
  isSteppedTransit,
  resolveSteppedActiveStepId,
  resolveSteppedChip,
  resolveSteppedStateLabel,
  resolveSteppedStatusLine,
  resolveSteppedTemperatureText,
} from '../../../shared-domain/src/planSteppedCardText.ts';
import {
  resolvePlanStateKind,
  type PlanStateKind,
} from '../../../shared-domain/src/planStateLabels.ts';
import { setTooltip } from './tooltips.ts';
import { getStoredDeviceControlProfile } from './deviceControlProfiles.ts';
import { resolveDisplayPlanDeviceSnapshot } from './planLiveData.ts';
import type { PlanDeviceSnapshot, PlanSnapshot, PlanStatusBinding } from './planTypes.ts';
import type { SteppedLoadProfile } from '../../../contracts/src/types.ts';

// ─── State kind helpers ───────────────────────────────────────────────────────

const isPlanStateKind = (value: string | undefined): value is PlanStateKind => (
  value === 'active'
  || value === 'idle'
  || value === 'held'
  || value === 'resuming'
  || value === 'manual'
  || value === 'unavailable'
  || value === 'unknown'
);

const resolveStateKind = (dev: PlanDeviceSnapshot): PlanStateKind => (
  isPlanStateKind(dev.stateKind) ? dev.stateKind : resolvePlanStateKind(dev)
);

// ─── Chips ────────────────────────────────────────────────────────────────────

const buildChip = (className: string, text: string, tooltip?: string): HTMLSpanElement => {
  const chip = document.createElement('span');
  chip.className = className;
  chip.textContent = text;
  if (tooltip) setTooltip(chip, tooltip);
  return chip;
};

const buildChipRow = (dev: PlanDeviceSnapshot): HTMLDivElement => {
  const chips = document.createElement('div');
  chips.className = 'plan-card__chips';

  const chip = resolveSteppedChip(dev);
  if (chip) chips.appendChild(buildChip(`plan-chip plan-chip--${chip.tone}`, chip.label));

  if (dev.temperatureBoostActive === true) {
    chips.appendChild(buildChip('plan-chip plan-chip--ok', 'Boost', 'Temperature boost is active'));
  } else if (dev.evBoostActive === true) {
    chips.appendChild(buildChip('plan-chip plan-chip--ok', 'Boost', 'EV boost is active'));
  }

  return chips;
};

// ─── Step rail ────────────────────────────────────────────────────────────────

const buildStepRailStop = (pct: number, isActive: boolean, isTarget: boolean, isFilled: boolean): HTMLDivElement => {
  const stop = document.createElement('div');
  stop.className = 'plan-card__step-stop';
  stop.style.left = `${pct}%`;
  if (isActive) stop.dataset.active = 'true';
  else if (isTarget) stop.dataset.target = 'true';
  else if (isFilled) stop.dataset.filled = 'true';
  return stop;
};

const buildStepRail = (
  dev: PlanDeviceSnapshot,
  profile: SteppedLoadProfile,
): HTMLDivElement => {
  const rail = document.createElement('div');
  rail.className = 'plan-card__step-rail';

  const transit = isSteppedTransit(dev);
  const activeStepId = resolveSteppedActiveStepId(dev, profile);
  const targetStepId = transit ? (dev.targetStepId ?? dev.desiredStepId ?? null) : null;

  const steps = profile.steps;
  const n = steps.length;
  const activeIdx = steps.findIndex((s) => s.id === activeStepId);
  const filledPct = n <= 1 || activeIdx < 0 ? 0 : (activeIdx / (n - 1)) * 100;

  const labelsRow = document.createElement('div');
  labelsRow.className = 'plan-card__step-labels';

  const track = document.createElement('div');
  track.className = 'plan-card__step-track';

  const filled = document.createElement('div');
  filled.className = 'plan-card__step-filled';
  filled.style.width = `${filledPct}%`;
  track.appendChild(filled);

  steps.forEach((step, i) => {
    const pct = n <= 1 ? 0 : (i / (n - 1)) * 100;
    const isActive = step.id === activeStepId;
    const isTarget = step.id === targetStepId && !isActive;
    const isFilled = activeIdx >= 0 && i < activeIdx;

    const labelEl = document.createElement('span');
    labelEl.className = 'plan-card__step-label';
    labelEl.textContent = capitalizeStepLabel(step.id);
    labelEl.style.left = `${pct}%`;
    labelsRow.appendChild(labelEl);

    track.appendChild(buildStepRailStop(pct, isActive, isTarget, isFilled));
  });

  rail.append(labelsRow, track);
  return rail;
};

// ─── Card body ────────────────────────────────────────────────────────────────

const buildStateRow = (dev: PlanDeviceSnapshot): HTMLDivElement => {
  const row = document.createElement('div');
  row.className = 'plan-card__state-row';

  const label = document.createElement('span');
  label.className = 'plan-card__state-label';
  label.textContent = resolveSteppedStateLabel(dev);
  row.appendChild(label);

  const tempText = resolveSteppedTemperatureText(dev);
  if (tempText) {
    const temp = document.createElement('span');
    temp.className = 'plan-card__temp-inline';
    temp.textContent = tempText;
    row.appendChild(temp);
  }

  return row;
};

const buildSteppedBody = (dev: PlanDeviceSnapshot, profile: SteppedLoadProfile, nowMs: number): {
  el: HTMLDivElement;
  statusLineEl: HTMLElement;
} => {
  const body = document.createElement('div');
  body.className = 'plan-card__stepped-body';

  body.appendChild(buildStateRow(dev));

  const statusLine = document.createElement('p');
  statusLine.className = 'plan-card__status-line';
  const statusText = resolveSteppedStatusLine(dev, profile, nowMs);
  statusLine.textContent = statusText ?? '';
  statusLine.style.visibility = statusText === null ? 'hidden' : '';
  body.appendChild(statusLine);

  body.appendChild(buildStepRail(dev, profile));

  return { el: body, statusLineEl: statusLine };
};

// ─── Card header ─────────────────────────────────────────────────────────────

const buildHeader = (dev: PlanDeviceSnapshot): HTMLDivElement => {
  const header = document.createElement('div');
  header.className = 'plan-card__header';

  const nameWrap = document.createElement('div');
  nameWrap.className = 'plan-card__title-wrap';
  const title = document.createElement('h3');
  title.className = 'plan-card__title';
  title.textContent = dev.name;
  nameWrap.appendChild(title);
  header.appendChild(nameWrap);

  header.appendChild(buildChipRow(dev));
  return header;
};

// ─── Card activation ─────────────────────────────────────────────────────────

const dispatchOpenDeviceDetail = (deviceId: string): void => {
  document.dispatchEvent(new CustomEvent('open-device-detail', { detail: { deviceId } }));
};

const attachCardActivation = (card: HTMLElement, deviceId: string): void => {
  card.addEventListener('click', () => { dispatchOpenDeviceDetail(deviceId); });
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

// ─── Public API ───────────────────────────────────────────────────────────────

const buildCardArticle = (dev: PlanDeviceSnapshot, stateKind: PlanStateKind): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'device-row plan-card plan-card--stepped clickable';
  card.dataset.deviceId = dev.id;
  card.dataset.stateKind = stateKind;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open device details for ${dev.name}`);
  if (stateKind === 'idle' || stateKind === 'manual') card.classList.add('plan-card--dim');
  if (stateKind === 'unavailable') card.classList.add('plan-card--unavailable');
  const elevation = document.createElement('md-elevation');
  elevation.setAttribute('aria-hidden', 'true');
  const ripple = document.createElement('md-ripple');
  ripple.setAttribute('aria-hidden', 'true');
  card.append(elevation, ripple);
  return card;
};

export const buildSteppedPlanCard = (
  plan: PlanSnapshot | null,
  dev: PlanDeviceSnapshot,
  renderedAtMs: number,
  nowMs: number,
): { el: HTMLElement; statusBinding: PlanStatusBinding } => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(plan, dev, renderedAtMs, nowMs);
  const stateKind = resolveStateKind(displayDev);
  const card = buildCardArticle(dev, stateKind);

  card.appendChild(buildHeader(displayDev));

  const profile = getStoredDeviceControlProfile(dev.id);
  let statusLineEl: HTMLElement;

  if (profile) {
    const body = buildSteppedBody(displayDev, profile, nowMs);
    card.appendChild(body.el);
    statusLineEl = body.statusLineEl;
  } else {
    // Profile not available yet — show state label only
    const fallback = document.createElement('p');
    fallback.className = 'plan-card__status-line';
    fallback.textContent = resolveSteppedStateLabel(displayDev);
    card.appendChild(fallback);
    statusLineEl = fallback;
  }

  attachCardActivation(card, dev.id);

  return {
    el: card,
    statusBinding: {
      device: dev,
      // reasonEl is unused for stepped cards — live updates re-render via renderPlanAt
      reasonEl: statusLineEl,
      chipEl: null,
      cooldownProgressEl: null,
    },
  };
};
