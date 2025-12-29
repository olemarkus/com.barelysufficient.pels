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
  limiter?: string;
};

type PlanMeta = NonNullable<PlanSnapshot['meta']>;

const getSoftLimitSourceLabel = (source?: PlanMeta['softLimitSource']) => {
  if (source === 'daily') return 'Daily';
  if (source === 'both') return 'Daily + capacity';
  return 'Capacity';
};

const getSoftLimitSourceValue = (meta: PlanMeta, fallback: number) => {
  if (meta.softLimitSource === 'daily' && typeof meta.dailySoftLimitKw === 'number') {
    return meta.dailySoftLimitKw;
  }
  return fallback;
};

const buildPlanMetaLines = (meta?: PlanSnapshot['meta']): PlanMetaLines | null => {
  if (!meta) return null;
  const { totalKw, softLimitKw, headroomKw } = meta;
  if (typeof totalKw !== 'number' || typeof softLimitKw !== 'number' || typeof headroomKw !== 'number') {
    return null;
  }

  const headroomAbs = Math.abs(headroomKw).toFixed(1);
  const headroomText = headroomKw >= 0 ? `${headroomAbs}kW available` : `${headroomAbs}kW over limit`;
  const powerText = `Now ${totalKw.toFixed(1)}kW / Limit ${softLimitKw.toFixed(1)}kW`;
  const nowLines = [powerText];
  let limiterText: string | undefined;
  if (meta.softLimitSource) {
    const sourceLabel = getSoftLimitSourceLabel(meta.softLimitSource);
    const sourceLimit = getSoftLimitSourceValue(meta, softLimitKw);
    limiterText = `Limiter ${sourceLabel} (${sourceLimit.toFixed(1)}kW)`;
  }
  nowLines.push(headroomText);
  const hourLines: string[] = [];

  if (typeof meta.controlledKw === 'number' && typeof meta.uncontrolledKw === 'number') {
    nowLines.push(`Controlled ${meta.controlledKw.toFixed(2)}kW / Uncontrolled ${meta.uncontrolledKw.toFixed(2)}kW`);
  }

  if (typeof meta.usedKWh === 'number' && typeof meta.budgetKWh === 'number') {
    hourLines.push(`Used ${meta.usedKWh.toFixed(2)} of ${meta.budgetKWh.toFixed(1)} kWh`);
  }
  if (typeof meta.hourControlledKWh === 'number' && typeof meta.hourUncontrolledKWh === 'number') {
    hourLines.push(`Controlled ${meta.hourControlledKWh.toFixed(2)} / Uncontrolled ${meta.hourUncontrolledKWh.toFixed(2)} kWh`);
  }
  if (typeof meta.minutesRemaining === 'number' && meta.minutesRemaining <= 10) {
    hourLines.push('End of hour');
  }

  return { now: nowLines, hour: hourLines, limiter: limiterText };
};

const renderPlanMeta = (meta?: PlanSnapshot['meta']) => {
  const metaLines = buildPlanMetaLines(meta);
  if (!metaLines) {
    planMeta.textContent = 'Awaiting data';
    return;
  }

  const { now: nowLines, hour: hourLines, limiter } = metaLines;

  planMeta.innerHTML = '';
  const addSection = (title: string, sectionLines: string[], pillText?: string) => {
    if (sectionLines.length === 0) return;
    const section = document.createElement('div');
    section.className = 'plan-meta-section';
    const heading = document.createElement('div');
    heading.className = 'plan-meta-title';
    heading.textContent = title;
    section.appendChild(heading);
    if (pillText) {
      const pillWrap = document.createElement('div');
      pillWrap.className = 'plan-meta-pill';
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = pillText;
      pillWrap.appendChild(pill);
      section.appendChild(pillWrap);
    }
    sectionLines.forEach((line) => {
      const div = document.createElement('div');
      div.className = 'plan-meta-line-text';
      div.textContent = line;
      section.appendChild(div);
    });
    planMeta.appendChild(section);
  };

  addSection('Now', nowLines, limiter);
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
