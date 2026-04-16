import { planList, planEmpty, planMeta } from './dom.ts';
import { SETTINGS_UI_PLAN_PATH, type SettingsUiPlanPayload } from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel } from './homey.ts';
import { createMetaLine } from './components.ts';
import { getPriceIndicatorIcon, type PriceIndicatorTone } from './priceIndicator.ts';
import {
  formatDeviceOverview,
  type DeviceOverviewStrings,
  type DeviceOverviewSnapshot,
} from '../../../shared-domain/src/deviceOverview.ts';
import { isGrayStateDevice } from './deviceUtils.ts';
import { setTooltip } from './tooltips.ts';

type PlanDeviceSnapshot = DeviceOverviewSnapshot & {
  id: string;
  name: string;
  plannedTarget?: number | null;
  priority?: number;
  zone?: string;
  budgetExempt?: boolean;
  currentTemperature?: number;
  headroomCardBlocked?: boolean;
  headroomCardCooldownSec?: number | null;
  headroomCardCooldownSource?: 'step_down' | 'pels_shed' | 'pels_restore';
  headroomCardCooldownFromKw?: number | null;
  headroomCardCooldownToKw?: number | null;
  pendingTargetCommand?: {
    desired: number;
    retryCount: number;
    nextRetryAtMs: number;
    status: 'waiting_confirmation' | 'temporary_unavailable';
  };
};

type PlanSnapshot = {
  meta?: {
    totalKw?: number;
    softLimitKw?: number;
    capacitySoftLimitKw?: number;
    dailySoftLimitKw?: number | null;
    softLimitSource?: 'capacity' | 'daily' | 'both';
    headroomKw?: number;
    capacityShortfall?: boolean;
    shortfallBudgetThresholdKw?: number;
    shortfallBudgetHeadroomKw?: number | null;
    hardCapHeadroomKw?: number | null;
    usedKWh?: number;
    budgetKWh?: number;
    minutesRemaining?: number;
    controlledKw?: number;
    uncontrolledKw?: number;
    hourControlledKWh?: number;
    hourUncontrolledKWh?: number;
    dailyBudgetHourKWh?: number;
    lastPowerUpdateMs?: number;
  };
  devices?: PlanDeviceSnapshot[];
};

const getPlanSnapshot = async (): Promise<PlanSnapshot | null> => {
  const payload = await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH);
  const plan = payload?.plan;
  if (!plan || typeof plan !== 'object') return null;
  return plan as PlanSnapshot;
};

type PlanMetaLines = {
  now: string[];
  hour: string[];
};

type PlanMeta = NonNullable<PlanSnapshot['meta']>;

const getSoftLimitSourceText = (source?: PlanMeta['softLimitSource']) => {
  if (source === 'daily') return 'Limited by daily budget';
  if (source === 'both') return 'Limited by daily + capacity caps';
  return 'Limited by capacity cap';
};

const getDisplayBudgetKWh = (meta: NonNullable<PlanSnapshot['meta']>): number | null => {
  if (typeof meta.usedKWh !== 'number' || typeof meta.budgetKWh !== 'number') return null;
  return meta.softLimitSource === 'daily' && typeof meta.dailyBudgetHourKWh === 'number'
    ? meta.dailyBudgetHourKWh
    : meta.budgetKWh;
};

type ValidatedMeta = {
  totalKw: number;
  softLimitKw: number;
  headroomKw: number;
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapHeadroomKw?: number | null;
  controlledKw?: number;
  uncontrolledKw?: number;
  lastPowerUpdateMs?: number;
};

type HardCapDisplay = {
  breached: boolean;
  breachText: string | null;
  remainingText: string | null;
};

const formatRelativeTime = (timestampMs: number): string => {
  const seconds = Math.round((Date.now() - timestampMs) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
};

const buildHardCapDisplay = (meta: ValidatedMeta): HardCapDisplay => {
  const { hardCapHeadroomKw } = meta;
  if (typeof hardCapHeadroomKw !== 'number') {
    return { breached: false, breachText: null, remainingText: null };
  }
  if (hardCapHeadroomKw < 0) {
    const breachKw = Math.abs(Math.min(0, hardCapHeadroomKw));
    return {
      breached: true,
      breachText: `Hard cap breached by ${breachKw.toFixed(1)}kW`,
      remainingText: null,
    };
  }
  return {
    breached: false,
    breachText: null,
    remainingText: `${hardCapHeadroomKw.toFixed(1)}kW before hard cap`,
  };
};

const buildNowLines = (meta: ValidatedMeta): string[] => {
  const {
    totalKw,
    softLimitKw,
    headroomKw,
    capacityShortfall,
    shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw,
    hardCapHeadroomKw,
    controlledKw,
    uncontrolledKw,
    lastPowerUpdateMs,
  } = meta;
  const headroomAbs = Math.abs(headroomKw).toFixed(1);
  const hardCap = buildHardCapDisplay(meta);
  const headroomText = hardCap.breachText
    ?? (headroomKw >= 0 ? `${headroomAbs}kW available` : `${headroomAbs}kW over soft limit`);
  const ageText = typeof lastPowerUpdateMs === 'number' ? ` (${formatRelativeTime(lastPowerUpdateMs)})` : '';
  const powerText = `Now ${totalKw.toFixed(1)}kW${ageText} (soft limit ${softLimitKw.toFixed(1)}kW)`;
  const lines = [powerText, headroomText];
  if ((capacityShortfall || hardCap.breached) && typeof shortfallBudgetThresholdKw === 'number') {
    lines.push(`Shortfall threshold ${shortfallBudgetThresholdKw.toFixed(1)}kW (hourly budget-derived)`);
  } else if (headroomKw < 0 && hardCap.remainingText) {
    lines.push(hardCap.remainingText);
  }
  if (typeof shortfallBudgetHeadroomKw === 'number' && shortfallBudgetHeadroomKw !== hardCapHeadroomKw) {
    lines.push(`Shortfall-threshold headroom ${shortfallBudgetHeadroomKw.toFixed(1)}kW`);
  }
  if (typeof controlledKw === 'number' && typeof uncontrolledKw === 'number') {
    lines.push(`Capacity-controlled ${controlledKw.toFixed(2)}kW / Other load ${uncontrolledKw.toFixed(2)}kW`);
  }
  return lines;
};

const buildHourLines = (meta: NonNullable<PlanSnapshot['meta']>): string[] => {
  const lines: string[] = [];
  if (meta.softLimitSource) {
    lines.push(getSoftLimitSourceText(meta.softLimitSource));
  }
  const displayBudget = getDisplayBudgetKWh(meta);
  if (displayBudget !== null && typeof meta.usedKWh === 'number') {
    lines.push(`Used ${meta.usedKWh.toFixed(2)} of ${displayBudget.toFixed(1)} kWh`);
  }
  if (typeof meta.hourControlledKWh === 'number' && typeof meta.hourUncontrolledKWh === 'number') {
    lines.push(
      `Capacity-controlled ${meta.hourControlledKWh.toFixed(2)} `
      + `/ Other load ${meta.hourUncontrolledKWh.toFixed(2)} kWh`,
    );
  }
  if (typeof meta.minutesRemaining === 'number' && meta.minutesRemaining <= 10) {
    lines.push('End of hour');
  }
  return lines;
};

const buildPlanMetaLines = (meta?: PlanSnapshot['meta']): PlanMetaLines | null => {
  if (!meta) return null;
  const { totalKw, softLimitKw, headroomKw } = meta;
  if (typeof totalKw !== 'number' || typeof softLimitKw !== 'number' || typeof headroomKw !== 'number') {
    return null;
  }
  const validated: ValidatedMeta = {
    totalKw,
    softLimitKw,
    headroomKw,
    capacityShortfall: meta.capacityShortfall,
    shortfallBudgetThresholdKw: meta.shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw: meta.shortfallBudgetHeadroomKw,
    hardCapHeadroomKw: meta.hardCapHeadroomKw,
    controlledKw: meta.controlledKw,
    uncontrolledKw: meta.uncontrolledKw,
    lastPowerUpdateMs: meta.lastPowerUpdateMs as number | undefined,
  };
  return { now: buildNowLines(validated), hour: buildHourLines(meta) };
};

const renderPlanMeta = (meta?: PlanSnapshot['meta']) => {
  const metaLines = buildPlanMetaLines(meta);
  if (!metaLines) {
    planMeta.textContent = 'Awaiting data';
    return;
  }

  const { now: nowLines, hour: hourLines } = metaLines;

  planMeta.innerHTML = '';
  const addSection = (title: string, sectionLines: string[]) => {
    if (sectionLines.length === 0) return;
    const section = document.createElement('div');
    section.className = 'plan-meta-section';
    const heading = document.createElement('div');
    heading.className = 'plan-meta-title';
    heading.textContent = title;
    section.appendChild(heading);
    sectionLines.forEach((line) => {
      const div = document.createElement('div');
      div.className = 'plan-meta-line-text';
      div.textContent = line;
      section.appendChild(div);
    });
    planMeta.appendChild(section);
  };

  addSection('Now', nowLines);
  if (nowLines.length && hourLines.length) {
    const divider = document.createElement('div');
    divider.className = 'plan-meta-divider';
    planMeta.appendChild(divider);
  }
  addSection('This hour', hourLines);
};

const hasPlanTempData = (dev: PlanDeviceSnapshot) => dev.plannedTarget !== null && dev.plannedTarget !== undefined
  || dev.currentTarget !== null && dev.currentTarget !== undefined
  || dev.currentTemperature !== null && dev.currentTemperature !== undefined;

const formatPlanTemp = (value: number | null | undefined): string => (
  typeof value === 'number' ? `${value.toFixed(1)}°` : '–'
);

const isSteppedLoadDevice = (dev: PlanDeviceSnapshot): boolean => dev.controlModel === 'stepped_load';

const buildPlanTemperatureLine = (dev: PlanDeviceSnapshot) => {
  if (!hasPlanTempData(dev)) return null;
  const currentTemp = formatPlanTemp(dev.currentTemperature);
  const currentTarget = typeof dev.currentTarget === 'number' ? `${dev.currentTarget}°` : '–';
  const plannedTarget = typeof dev.plannedTarget === 'number' ? `${dev.plannedTarget}°` : '–';
  const targetChanging = dev.plannedTarget != null && dev.plannedTarget !== dev.currentTarget;
  let pendingSuffix = '';
  if (
    dev.pendingTargetCommand
    && typeof dev.plannedTarget === 'number'
    && dev.pendingTargetCommand.desired === dev.plannedTarget
  ) {
    pendingSuffix = dev.pendingTargetCommand.status === 'temporary_unavailable'
      ? ' (temporarily unavailable)'
      : ' (waiting for confirmation)';
  }
  const targetText = targetChanging ? `${currentTarget} → ${plannedTarget}` : currentTarget;
  const targetTextWithPending = `${targetText}${pendingSuffix}`;
  return createMetaLine('Temperature', `${currentTemp} / target ${targetTextWithPending}`);
};

const isRestoreCooldownReason = (reason: string | undefined): boolean => {
  if (!reason) return false;
  return reason.startsWith('cooldown (restore') || reason === 'restore throttled';
};

const isRestoreCooldownState = (dev: PlanDeviceSnapshot): boolean => (
  dev.plannedState === 'shed' && isRestoreCooldownReason(dev.reason)
);

const buildPlanPowerLine = (overview: DeviceOverviewStrings) => {
  return overview.powerMsg ? createMetaLine('Power', overview.powerMsg) : null;
};

const buildPlanStateLine = (overview: DeviceOverviewStrings) => {
  return createMetaLine('State', overview.stateMsg);
};

const buildPlanUsageLine = (overview: DeviceOverviewStrings) => {
  return createMetaLine('Usage', overview.usageMsg);
};

const buildPlanStatusLine = (overview: DeviceOverviewStrings) => {
  return createMetaLine('Status', overview.statusMsg);
};

const isOnLikeState = (value: string | undefined): boolean => {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== 'off' && normalized !== 'unknown' && normalized !== 'not_applicable';
};

const isOffLikeState = (state?: string): boolean =>
  state === 'off' || state === 'unknown';

const resolvePlanBadgeState = (
  dev: PlanDeviceSnapshot,
): 'active' | 'inactive' | 'shed' | 'uncontrolled' | 'restoring' | 'unknown' => {
  const steppedRestorePending = isSteppedLoadDevice(dev)
    && Boolean(dev.selectedStepId && dev.desiredStepId && dev.selectedStepId !== dev.desiredStepId);
  if (dev.controllable === false) return 'uncontrolled';
  if (isGrayStateDevice(dev)) return 'unknown';
  if (dev.plannedState === 'inactive') return 'inactive';
  const restoreCooldownState = resolveRestoreCooldownBadgeState(dev);
  if (restoreCooldownState) return restoreCooldownState;
  if (dev.plannedState === 'shed') return 'shed';
  if (dev.binaryCommandPending && isOffLikeState(dev.currentState)) return 'restoring';
  if (steppedRestorePending) return 'restoring';
  if (dev.currentState === 'not_applicable') return 'active';
  if (isOnLikeState(dev.currentState)) return 'active';
  return 'restoring';
};

const resolveRestoreCooldownBadgeState = (dev: PlanDeviceSnapshot): 'active' | 'restoring' | null => {
  if (!isRestoreCooldownState(dev)) return null;
  if (dev.currentState === 'not_applicable' || isOnLikeState(dev.currentState)) return 'active';
  return 'restoring';
};

const getPlanStateTone = (
  state: 'active' | 'inactive' | 'shed' | 'uncontrolled' | 'restoring' | 'unknown',
): PriceIndicatorTone => {
  if (state === 'shed') return 'expensive';
  if (state === 'inactive' || state === 'uncontrolled' || state === 'restoring' || state === 'unknown') {
    return 'neutral';
  }
  return 'cheap';
};

const buildPlanStateBadge = (dev: PlanDeviceSnapshot) => {
  const badge = document.createElement('span');
  const state = resolvePlanBadgeState(dev);
  const tone = getPlanStateTone(state);
  let label = 'Active';
  if (state === 'inactive') {
    label = 'Inactive';
  } else if (state === 'shed') {
    label = 'Shed';
  } else if (state === 'uncontrolled') {
    label = 'Uncontrolled';
  } else if (state === 'restoring') {
    label = 'Restoring';
  } else if (state === 'unknown') {
    label = dev.available === false ? 'Unavailable' : 'State unknown';
  }
  badge.className = `plan-state-indicator price-indicator ${tone}`;
  badge.dataset.icon = getPriceIndicatorIcon(tone);
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', label);
  setTooltip(badge, label);
  return badge;
};

const dispatchOpenDeviceDetail = (deviceId: string) => {
  document.dispatchEvent(new CustomEvent('open-device-detail', { detail: { deviceId } }));
};

const buildBudgetExemptChip = () => {
  const chip = document.createElement('span');
  chip.className = 'chip chip--ok plan-row__chip';
  chip.textContent = 'Budget exempt';
  return chip;
};

const buildPlanRow = (dev: PlanDeviceSnapshot) => {
  const overview = formatDeviceOverview(dev);
  const row = document.createElement('li');
  row.className = 'device-row plan-row clickable';
  row.dataset.deviceId = dev.id;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Open device details for ${dev.name}`);

  const name = document.createElement('div');
  name.className = 'device-row__name plan-row__name';
  name.append(buildPlanStateBadge(dev), document.createTextNode(dev.name));
  if (dev.budgetExempt === true) {
    name.appendChild(buildBudgetExemptChip());
  }

  const metaWrap = document.createElement('div');
  metaWrap.className = 'device-row__target plan-row__meta';

  const tempLine = buildPlanTemperatureLine(dev);
  if (tempLine) metaWrap.appendChild(tempLine);
  const powerLine = buildPlanPowerLine(overview);
  if (powerLine) metaWrap.appendChild(powerLine);

  metaWrap.append(
    buildPlanStateLine(overview),
    buildPlanUsageLine(overview),
    buildPlanStatusLine(overview),
  );

  row.addEventListener('click', () => {
    dispatchOpenDeviceDetail(dev.id);
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    dispatchOpenDeviceDetail(dev.id);
  });
  row.addEventListener('keyup', (event) => {
    if (event.key !== ' ') return;
    event.preventDefault();
    dispatchOpenDeviceDetail(dev.id);
  });

  row.append(name, metaWrap);
  return row;
};

export const renderPlan = (plan: PlanSnapshot | null) => {
  planList.innerHTML = '';
  if (!plan) {
    planEmpty.hidden = false;
    planEmpty.textContent = 'No plan available yet. Send power data or refresh devices.';
    planMeta.textContent = 'Awaiting data…';
    return;
  }
  renderPlanMeta(plan.meta);

  const devices = Array.isArray(plan.devices) ? plan.devices : [];
  if (devices.length === 0) {
    planEmpty.hidden = false;
    planEmpty.textContent = 'No managed devices.';
    return;
  }

  planEmpty.hidden = true;

  // Sort all devices globally by priority (priority 1 = most important = first)
  const sortedDevices = [...devices].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  sortedDevices.forEach((dev) => {
    planList.appendChild(buildPlanRow(dev));
  });
};

export const refreshPlan = async () => {
  const plan = await getPlanSnapshot();
  renderPlan(plan);
};

export type { PlanSnapshot };
