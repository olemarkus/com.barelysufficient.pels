import { planList, planEmpty, planMeta } from './dom';
import { getSetting } from './homey';
import { createMetaLine } from './components';

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
    headroomKw?: number;
    usedKWh?: number;
    budgetKWh?: number;
    minutesRemaining?: number;
    controlledKw?: number;
    uncontrolledKw?: number;
  };
  devices?: PlanDeviceSnapshot[];
};

const getPlanSnapshot = async (): Promise<PlanSnapshot | null> => {
  const plan = await getSetting('device_plan_snapshot');
  if (!plan || typeof plan !== 'object') return null;
  return plan as PlanSnapshot;
};

const buildPlanMetaLines = (meta?: PlanSnapshot['meta']): string[] | null => {
  if (!meta) return null;
  const { totalKw, softLimitKw, headroomKw } = meta;
  if (typeof totalKw !== 'number' || typeof softLimitKw !== 'number' || typeof headroomKw !== 'number') {
    return null;
  }

  const headroomAbs = Math.abs(headroomKw).toFixed(1);
  const headroomText = headroomKw >= 0 ? `${headroomAbs}kW available` : `${headroomAbs}kW over limit`;
  const powerText = `Now ${totalKw.toFixed(1)}kW / Limit ${softLimitKw.toFixed(1)}kW`;
  const lines = [powerText, headroomText];

  if (typeof meta.controlledKw === 'number' && typeof meta.uncontrolledKw === 'number') {
    lines.push(`Controlled ${meta.controlledKw.toFixed(2)}kW / Uncontrolled ${meta.uncontrolledKw.toFixed(2)}kW`);
  }

  if (typeof meta.usedKWh === 'number' && typeof meta.budgetKWh === 'number') {
    lines.push(`This hour: ${meta.usedKWh.toFixed(2)} of ${meta.budgetKWh.toFixed(1)}kWh`);
  }
  if (typeof meta.minutesRemaining === 'number' && meta.minutesRemaining <= 10) {
    lines.push('End of hour');
  }

  return lines;
};

const renderPlanMeta = (meta?: PlanSnapshot['meta']) => {
  const lines = buildPlanMetaLines(meta);
  if (!lines) {
    planMeta.textContent = 'Awaiting data';
    return;
  }
  planMeta.innerHTML = '';
  lines.forEach((line) => {
    const div = document.createElement('div');
    div.textContent = line;
    planMeta.appendChild(div);
  });
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
  const currentPower = dev.currentState || 'unknown';
  const isMinTempActive = dev.shedAction === 'set_temperature'
    && typeof dev.shedTemperature === 'number'
    && dev.currentTarget === dev.shedTemperature;
  let plannedPowerState = dev.plannedState || 'keep';
  if (dev.plannedState === 'shed') {
    plannedPowerState = dev.shedAction === 'set_temperature' ? 'on' : 'off';
  } else if (dev.plannedState === 'keep') {
    plannedPowerState = isMinTempActive ? 'on' : currentPower;
  }
  const powerChanging = plannedPowerState !== currentPower;
  const powerText = powerChanging ? `${currentPower} → ${plannedPowerState}` : plannedPowerState;
  return createMetaLine('Power', powerText);
};

const buildPlanStateLine = (dev: PlanDeviceSnapshot) => {
  let stateText = 'Unknown';
  if (dev.plannedState === 'shed') {
    stateText = dev.shedAction === 'set_temperature'
      ? 'Shed (lowered temperature)'
      : 'Shed (powered off)';
  } else if (dev.plannedState === 'keep') {
    stateText = (dev.currentState === 'off' || dev.currentState === 'unknown') ? 'Restoring' : 'Keep';
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

const buildPlanRow = (dev: PlanDeviceSnapshot) => {
  const row = document.createElement('div');
  row.className = 'device-row plan-row';
  row.setAttribute('role', 'listitem');
  row.dataset.deviceId = dev.id;

  const name = document.createElement('div');
  name.className = 'device-row__name';
  name.textContent = dev.name;

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
  if (!plan || !Array.isArray(plan.devices) || plan.devices.length === 0) {
    planEmpty.hidden = false;
    planMeta.textContent = 'Awaiting data…';
    return;
  }
  planEmpty.hidden = true;

  renderPlanMeta(plan.meta);

  // Sort all devices globally by priority (priority 1 = most important = first)
  const sortedDevices = [...plan.devices].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  sortedDevices.forEach((dev) => {
    planList.appendChild(buildPlanRow(dev));
  });
};

export const refreshPlan = async () => {
  const plan = await getPlanSnapshot();
  renderPlan(plan);
};

export type { PlanSnapshot };
