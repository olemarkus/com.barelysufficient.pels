import { planList, planEmpty, planMeta } from './dom.ts';
import { SETTINGS_UI_PLAN_PATH, type SettingsUiPlanPayload } from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel } from './homey.ts';
import { createMetaLine } from './components.ts';
import { getPriceIndicatorIcon, type PriceIndicatorTone } from './priceIndicator.ts';

type PlanDeviceSnapshot = {
  id: string;
  name: string;
  currentState: string;
  plannedState: string;
  controlModel?: 'temperature_target' | 'binary_power' | 'stepped_load';
  currentTarget?: unknown;
  plannedTarget?: number | null;
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  planningPowerKw?: number;
  reason?: string;
  zone?: string;
  controllable?: boolean;
  budgetExempt?: boolean;
  currentTemperature?: number;
  shedAction?: 'turn_off' | 'set_temperature' | 'set_step';
  shedTemperature?: number | null;
  selectedStepId?: string;
  desiredStepId?: string;
  actualStepId?: string;
  assumedStepId?: string;
  binaryCommandPending?: boolean;
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
  controlledKw?: number;
  uncontrolledKw?: number;
  lastPowerUpdateMs?: number;
};

const formatRelativeTime = (timestampMs: number): string => {
  const seconds = Math.round((Date.now() - timestampMs) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
};

const buildNowLines = (meta: ValidatedMeta): string[] => {
  const { totalKw, softLimitKw, headroomKw, controlledKw, uncontrolledKw, lastPowerUpdateMs } = meta;
  const headroomAbs = Math.abs(headroomKw).toFixed(1);
  const headroomText = headroomKw >= 0 ? `${headroomAbs}kW available` : `${headroomAbs}kW over soft limit`;
  const ageText = typeof lastPowerUpdateMs === 'number' ? ` (${formatRelativeTime(lastPowerUpdateMs)})` : '';
  const powerText = `Now ${totalKw.toFixed(1)}kW${ageText} (soft limit ${softLimitKw.toFixed(1)}kW)`;
  const lines = [powerText, headroomText];
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

const getDisplayedSteppedStepId = (dev: PlanDeviceSnapshot): string | undefined => (
  dev.actualStepId ?? dev.assumedStepId ?? dev.selectedStepId
);

const getSteppedUsageStepText = (dev: PlanDeviceSnapshot): string | null => {
  const selectedStepId = getDisplayedSteppedStepId(dev);
  const desiredStepId = dev.desiredStepId;
  if (!selectedStepId && !desiredStepId) return null;
  if (!selectedStepId) return desiredStepId ? `→ ${desiredStepId}` : null;
  if (desiredStepId && desiredStepId !== selectedStepId) {
    return `${selectedStepId} → ${desiredStepId}`;
  }
  return selectedStepId;
};

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

const resolvePlannedPowerState = (
  dev: PlanDeviceSnapshot,
  currentPowerRaw: string,
  currentPower: string,
): string => {
  if (currentPowerRaw === 'not_applicable') return currentPower;

  const isMinTempActive = dev.shedAction === 'set_temperature'
    && typeof dev.shedTemperature === 'number'
    && dev.currentTarget === dev.shedTemperature;

  switch (dev.plannedState) {
    case 'shed':
      return dev.shedAction === 'set_temperature' ? 'on' : 'off';
    case 'inactive':
      return currentPowerRaw === 'unknown' ? currentPower : 'off';
    case 'keep':
      return isMinTempActive ? 'on' : currentPower;
    default:
      return dev.plannedState || currentPower;
  }
};

const isRestoreCooldownReason = (reason: string | undefined): boolean => {
  if (!reason) return false;
  return reason.startsWith('cooldown (restore') || reason === 'restore throttled';
};

const isRestoreCooldownState = (dev: PlanDeviceSnapshot): boolean => (
  dev.plannedState === 'shed' && isRestoreCooldownReason(dev.reason)
);

const isActiveStatusDevice = (dev: PlanDeviceSnapshot): boolean => (
  dev.currentState === 'not_applicable' || isOnLikeState(dev.currentState)
);

const formatActivePlanStatusReason = (reason: string): string => {
  const restoreMatch = reason.match(/^cooldown \(restore, (.+)\)$/);
  if (restoreMatch) {
    return `stabilizing after restore (${restoreMatch[1]})`;
  }

  const headroomRestoreMatch = reason.match(/^headroom cooldown \((.+); recent PELS restore\)$/);
  if (headroomRestoreMatch) {
    return `stabilizing after recent PELS restore (${headroomRestoreMatch[1]})`;
  }

  const headroomShedMatch = reason.match(/^headroom cooldown \((.+); recent PELS shed\)$/);
  if (headroomShedMatch) {
    return `stabilizing after recent PELS shed (${headroomShedMatch[1]})`;
  }

  const stepDownMatch = reason.match(/^headroom cooldown \((.+); usage (.+)\)$/);
  if (stepDownMatch) {
    return `stabilizing after recent step-down (${stepDownMatch[1]}; usage ${stepDownMatch[2]})`;
  }

  return reason;
};

const buildPlanPowerLine = (dev: PlanDeviceSnapshot) => {
  if (isSteppedLoadDevice(dev)) return null;
  const currentPowerRaw = dev.currentState || 'unknown';
  if (currentPowerRaw === 'not_applicable') return null;
  const currentPower = currentPowerRaw === 'not_applicable' ? 'N/A' : currentPowerRaw;
  const plannedPowerState = resolvePlannedPowerState(dev, currentPowerRaw, currentPower);
  const powerChanging = plannedPowerState !== currentPower;
  const powerText = powerChanging ? `${currentPower} → ${plannedPowerState}` : plannedPowerState;
  return createMetaLine('Power', powerText);
};

// eslint-disable-next-line sonarjs/cognitive-complexity, complexity
const buildPlanStateLine = (dev: PlanDeviceSnapshot) => {
  let stateText = 'Unknown';
  const steppedRestorePending = isSteppedLoadDevice(dev)
    && Boolean(dev.selectedStepId && dev.desiredStepId && dev.selectedStepId !== dev.desiredStepId);
  if (dev.controllable === false) {
    stateText = 'Capacity control off';
    return createMetaLine('State', stateText);
  }
  if (isRestoreCooldownState(dev)) {
    stateText = isOffLikeState(dev.currentState)
      ? 'Shed (restore cooldown)'
      : 'Active';
  } else if (dev.plannedState === 'shed') {
    if (dev.shedAction === 'set_temperature') {
      stateText = 'Shed (lowered temperature)';
    } else if (dev.shedAction === 'set_step') {
      stateText = dev.desiredStepId ? `Shed to ${dev.desiredStepId}` : 'Shed (reduced step)';
    } else {
      stateText = 'Shed (powered off)';
    }
  } else if (dev.plannedState === 'inactive') {
    stateText = 'Inactive';
  } else if (dev.plannedState === 'keep') {
    if (dev.binaryCommandPending && isOffLikeState(dev.currentState)) {
      stateText = 'Restore requested';
    } else if (steppedRestorePending || isOffLikeState(dev.currentState)) {
      stateText = 'Restoring';
    } else if (dev.currentState === 'not_applicable') {
      stateText = 'Active (temperature-managed)';
    } else {
      stateText = 'Active';
    }
  }
  return createMetaLine('State', stateText);
};

const formatUsageText = (params: {
  measuredKw?: number;
  expectedKw?: number;
}): string => {
  const { measuredKw, expectedKw } = params;
  const hasMeasured = typeof measuredKw === 'number' && Number.isFinite(measuredKw);
  const hasExpected = typeof expectedKw === 'number' && Number.isFinite(expectedKw);
  if (hasExpected && hasMeasured) {
    return `Measured: ${measuredKw.toFixed(2)} kW / Expected: ${expectedKw.toFixed(2)} kW`;
  }
  if (hasExpected) return `Expected: ${expectedKw.toFixed(2)} kW`;
  if (hasMeasured) return `Measured: ${measuredKw.toFixed(2)} kW`;
  return 'Unknown';
};

const buildPlanUsageLine = (dev: PlanDeviceSnapshot) => {
  const measuredKw = dev.measuredPowerKw;
  const expectedKw = isSteppedLoadDevice(dev)
    ? dev.planningPowerKw ?? dev.expectedPowerKw
    : dev.expectedPowerKw;
  let usageText = formatUsageText({ measuredKw, expectedKw });

  if (isSteppedLoadDevice(dev)) {
    const stepText = getSteppedUsageStepText(dev);
    if (stepText) {
      usageText = `${usageText} (${stepText})`;
    }
  }

  return createMetaLine('Usage', usageText);
};

const buildPlanStatusLine = (dev: PlanDeviceSnapshot) => {
  if (!dev.reason) return createMetaLine('Status', 'Waiting for headroom');
  const statusText = isActiveStatusDevice(dev)
    ? formatActivePlanStatusReason(dev.reason)
    : dev.reason;
  return createMetaLine('Status', statusText);
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
): 'active' | 'inactive' | 'shed' | 'uncontrolled' | 'restoring' => {
  const steppedRestorePending = isSteppedLoadDevice(dev)
    && Boolean(dev.selectedStepId && dev.desiredStepId && dev.selectedStepId !== dev.desiredStepId);
  if (dev.controllable === false) return 'uncontrolled';
  if (dev.plannedState === 'inactive') return 'inactive';
  if (isRestoreCooldownState(dev)) {
    if (dev.currentState === 'not_applicable' || isOnLikeState(dev.currentState)) return 'active';
    return 'restoring';
  }
  if (dev.plannedState === 'shed') return 'shed';
  if (dev.binaryCommandPending && isOffLikeState(dev.currentState)) return 'restoring';
  if (steppedRestorePending) return 'restoring';
  if (dev.currentState === 'not_applicable') return 'active';
  if (isOnLikeState(dev.currentState)) return 'active';
  return 'restoring';
};

const getPlanStateTone = (state: 'active' | 'inactive' | 'shed' | 'uncontrolled' | 'restoring'): PriceIndicatorTone => {
  if (state === 'shed') return 'expensive';
  if (state === 'inactive' || state === 'uncontrolled' || state === 'restoring') return 'neutral';
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
  }
  badge.className = `plan-state-indicator price-indicator ${tone}`;
  badge.dataset.icon = getPriceIndicatorIcon(tone);
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', label);
  badge.title = label;
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
  const powerLine = buildPlanPowerLine(dev);
  if (powerLine) metaWrap.appendChild(powerLine);

  metaWrap.append(
    buildPlanStateLine(dev),
    buildPlanUsageLine(dev),
    buildPlanStatusLine(dev),
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
