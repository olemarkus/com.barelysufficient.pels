import { planList, planEmpty, planMeta } from './dom';
import { getSetting } from './homey';
import { createMetaLine } from './components';
import { getPriceIndicatorIcon, type PriceIndicatorTone } from './priceIndicator';

type PlanDeviceSnapshot = {
  id: string;
  name: string;
  currentState: string;
  plannedState: string;
  currentTarget?: unknown;
  plannedTarget?: number | null;
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  reason?: string;
  zone?: string;
  controllable?: boolean;
  currentTemperature?: number;
  shedAction?: 'turn_off' | 'set_temperature';
  shedTemperature?: number | null;
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
  };
  devices?: PlanDeviceSnapshot[];
};

const getPlanSnapshot = async (): Promise<PlanSnapshot | null> => {
  const plan = await getSetting('device_plan_snapshot');
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
};

const buildNowLines = (meta: ValidatedMeta): string[] => {
  const { totalKw, softLimitKw, headroomKw, controlledKw, uncontrolledKw } = meta;
  const headroomAbs = Math.abs(headroomKw).toFixed(1);
  const headroomText = headroomKw >= 0 ? `${headroomAbs}kW available` : `${headroomAbs}kW over limit`;
  const powerText = `Now ${totalKw.toFixed(1)}kW (limit ${softLimitKw.toFixed(1)}kW)`;
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
    lines.push(`Capacity-controlled ${meta.hourControlledKWh.toFixed(2)} / Other load ${meta.hourUncontrolledKWh.toFixed(2)} kWh`);
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

const buildPlanTemperatureLine = (dev: PlanDeviceSnapshot) => {
  if (!hasPlanTempData(dev)) return null;
  const currentTemp = formatPlanTemp(dev.currentTemperature);
  const currentTarget = typeof dev.currentTarget === 'number' ? `${dev.currentTarget}°` : '–';
  const plannedTarget = typeof dev.plannedTarget === 'number' ? `${dev.plannedTarget}°` : '–';
  const targetChanging = dev.plannedTarget != null && dev.plannedTarget !== dev.currentTarget;
  const targetText = targetChanging ? `${currentTarget} → ${plannedTarget}` : currentTarget;
  return createMetaLine('Temperature', `${currentTemp} / target ${targetText}`);
};

const buildPlanPowerLine = (dev: PlanDeviceSnapshot) => {
  const currentPowerRaw = dev.currentState || 'unknown';
  const currentPower = currentPowerRaw === 'not_applicable' ? 'N/A' : currentPowerRaw;
  const isMinTempActive = dev.shedAction === 'set_temperature'
    && typeof dev.shedTemperature === 'number'
    && dev.currentTarget === dev.shedTemperature;
  let plannedPowerState = currentPower;
  if (currentPowerRaw !== 'not_applicable') {
    plannedPowerState = dev.plannedState || 'keep';
    if (dev.plannedState === 'shed') {
      plannedPowerState = dev.shedAction === 'set_temperature' ? 'on' : 'off';
    } else if (dev.plannedState === 'keep') {
      plannedPowerState = isMinTempActive ? 'on' : currentPower;
    }
  }
  const powerChanging = plannedPowerState !== currentPower;
  const powerText = powerChanging ? `${currentPower} → ${plannedPowerState}` : plannedPowerState;
  return createMetaLine('Power', powerText);
};

const buildPlanStateLine = (dev: PlanDeviceSnapshot) => {
  let stateText = 'Unknown';
  if (dev.controllable === false) {
    stateText = 'Capacity control off';
    return createMetaLine('State', stateText);
  }
  if (dev.plannedState === 'shed') {
    stateText = dev.shedAction === 'set_temperature'
      ? 'Shed (lowered temperature)'
      : 'Shed (powered off)';
  } else if (dev.plannedState === 'keep') {
    if (dev.currentState === 'off' || dev.currentState === 'unknown') {
      stateText = 'Restoring';
    } else if (dev.currentState === 'not_applicable') {
      stateText = 'Active (temperature-managed)';
    } else {
      stateText = 'Active';
    }
  }
  return createMetaLine('State', stateText);
};

const buildPlanUsageLine = (dev: PlanDeviceSnapshot) => {
  const measuredKw = dev.measuredPowerKw;
  const expectedKw = dev.expectedPowerKw;
  const hasMeasured = typeof measuredKw === 'number' && Number.isFinite(measuredKw);
  const hasExpected = typeof expectedKw === 'number' && Number.isFinite(expectedKw);

  let usageText = 'Unknown';
  if (hasExpected && hasMeasured) {
    const measuredText = measuredKw.toFixed(2);
    const expectedText = expectedKw.toFixed(2);
    usageText = measuredText === expectedText
      ? `expected ${expectedText} kW`
      : `current usage: ${measuredText} kW / expected ${expectedText} kW`;
  } else if (hasExpected) {
    usageText = `expected ${expectedKw.toFixed(2)} kW`;
  } else if (hasMeasured) {
    usageText = `current usage: ${measuredKw.toFixed(2)} kW`;
  }

  return createMetaLine('Usage', usageText);
};

const buildPlanStatusLine = (dev: PlanDeviceSnapshot) => createMetaLine('Status', dev.reason || 'Waiting for headroom');

const isOnLikeState = (value: string | undefined): boolean => {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== 'off' && normalized !== 'unknown' && normalized !== 'not_applicable';
};

const resolvePlanBadgeState = (dev: PlanDeviceSnapshot): 'active' | 'shed' | 'uncontrolled' | 'restoring' => {
  if (dev.controllable === false) return 'uncontrolled';
  if (dev.plannedState === 'shed') return 'shed';
  if (dev.currentState === 'not_applicable') return 'active';
  if (isOnLikeState(dev.currentState)) return 'active';
  return 'restoring';
};

const getPlanStateTone = (state: 'active' | 'shed' | 'uncontrolled' | 'restoring'): PriceIndicatorTone => {
  if (state === 'shed') return 'expensive';
  if (state === 'uncontrolled' || state === 'restoring') return 'neutral';
  return 'cheap';
};

const buildPlanStateBadge = (dev: PlanDeviceSnapshot) => {
  const badge = document.createElement('span');
  const state = resolvePlanBadgeState(dev);
  const tone = getPlanStateTone(state);
  let label = 'Active';
  if (state === 'shed') {
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

const buildPlanRow = (dev: PlanDeviceSnapshot) => {
  const row = document.createElement('li');
  row.className = 'device-row plan-row';
  row.dataset.deviceId = dev.id;

  const name = document.createElement('div');
  name.className = 'device-row__name plan-row__name';
  name.append(buildPlanStateBadge(dev), document.createTextNode(dev.name));

  const metaWrap = document.createElement('div');
  metaWrap.className = 'device-row__target plan-row__meta';

  const tempLine = buildPlanTemperatureLine(dev);
  if (tempLine) metaWrap.appendChild(tempLine);

  metaWrap.append(
    buildPlanPowerLine(dev),
    buildPlanStateLine(dev),
    buildPlanUsageLine(dev),
    buildPlanStatusLine(dev),
  );

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
