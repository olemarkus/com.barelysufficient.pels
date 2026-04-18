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
import { createLivePlanController } from './planLive.ts';
import {
  getDisplayReason,
  planNeedsLiveUpdates,
  resolveSnapshotGeneratedAtMs,
} from './planLiveData.ts';
import { renderPlanMeta, type PlanMetaBinding, type PlanMetaSnapshot, updatePlanMetaBinding } from './planMeta.ts';

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
  generatedAtMs?: number;
  meta?: PlanMetaSnapshot;
  devices?: PlanDeviceSnapshot[];
};

const getPlanSnapshotFromPayload = (payload: SettingsUiPlanPayload | null | undefined): PlanSnapshot | null => {
  const plan = payload?.plan;
  if (!plan || typeof plan !== 'object') return null;
  return plan as PlanSnapshot;
};

const getPlanSnapshot = async (): Promise<PlanSnapshot | null> => (
  getPlanSnapshotFromPayload(await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH))
);

type PlanStatusBinding = {
  device: PlanDeviceSnapshot;
  valueEl: HTMLSpanElement;
};

let liveStatusBindings: PlanStatusBinding[] = [];
let liveMetaBinding: PlanMetaBinding | null = null;
let cachedOverviewPanel: Element | null = null;
let hasCachedOverviewPanel = false;

const resetLiveBindings = () => {
  liveStatusBindings = [];
  liveMetaBinding = null;
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

const buildPlanPowerLine = (overview: DeviceOverviewStrings) => {
  return overview.powerMsg ? createMetaLine('Power', overview.powerMsg) : null;
};

const buildPlanStateLine = (overview: DeviceOverviewStrings) => {
  return createMetaLine('State', overview.stateMsg);
};

const buildPlanUsageLine = (overview: DeviceOverviewStrings) => {
  return createMetaLine('Usage', overview.usageMsg);
};

const buildPlanStatusLine = (dev: PlanDeviceSnapshot, overview: DeviceOverviewStrings) => {
  const line = createMetaLine('Status', overview.statusMsg);
  const valueEl = line.querySelector('span:last-child');
  if (valueEl instanceof HTMLSpanElement) {
    liveStatusBindings.push({ device: dev, valueEl });
  }
  return line;
};

const getDisplayPlanDeviceSnapshot = (
  plan: PlanSnapshot | null,
  dev: PlanDeviceSnapshot,
  renderedAtMs: number,
  nowMs: number,
): PlanDeviceSnapshot => {
  const displayReason = getDisplayReason(dev.reason, resolveSnapshotGeneratedAtMs(plan, renderedAtMs), nowMs);
  if (displayReason === dev.reason) return dev;
  return { ...dev, reason: displayReason };
};

const isOnLikeState = (value: string | undefined): boolean => {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== 'off' && normalized !== 'unknown' && normalized !== 'not_applicable';
};

const isOffLikeState = (state?: string): boolean =>
  state === 'off' || state === 'unknown';

const hasSteppedRestorePending = (dev: PlanDeviceSnapshot): boolean => (
  isSteppedLoadDevice(dev)
  && isOffLikeState(dev.currentState)
  && Boolean(dev.selectedStepId && dev.desiredStepId && dev.selectedStepId !== dev.desiredStepId)
);

const isPlanBadgeActiveState = (dev: PlanDeviceSnapshot): boolean => (
  dev.currentState === 'not_applicable'
  || isOnLikeState(dev.currentState)
);

const resolvePlanBadgeState = (
  dev: PlanDeviceSnapshot,
): 'active' | 'inactive' | 'shed' | 'uncontrolled' | 'restoring' | 'unknown' => {
  if (dev.controllable === false) return 'uncontrolled';
  if (isGrayStateDevice(dev)) return 'unknown';
  if (dev.plannedState === 'inactive') return 'inactive';
  if (dev.plannedState === 'shed') return 'shed';
  if (dev.binaryCommandPending && isOffLikeState(dev.currentState)) return 'restoring';
  if (hasSteppedRestorePending(dev)) return 'restoring';
  if (isPlanBadgeActiveState(dev)) return 'active';
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

const buildPlanRow = (plan: PlanSnapshot | null, dev: PlanDeviceSnapshot, renderedAtMs: number, nowMs: number) => {
  const displayDev = getDisplayPlanDeviceSnapshot(plan, dev, renderedAtMs, nowMs);
  const overview = formatDeviceOverview(displayDev);
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
    buildPlanStatusLine(dev, overview),
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

const isOverviewVisible = (): boolean => {
  if (typeof document === 'undefined') return true;
  if (typeof document.hidden === 'boolean' && document.hidden) return false;
  if (!hasCachedOverviewPanel || cachedOverviewPanel === null) {
    cachedOverviewPanel = document.querySelector('#overview-panel');
    hasCachedOverviewPanel = cachedOverviewPanel !== null;
  }
  const overviewPanel = cachedOverviewPanel;
  if (!overviewPanel) return true;
  return !overviewPanel.classList.contains('hidden');
};

const updateLivePlanAt = (_plan: PlanSnapshot | null, renderedAtMs: number, nowMs: number) => {
  updatePlanMetaBinding(liveMetaBinding, nowMs);
  liveStatusBindings.forEach((binding) => {
    const displayDev = getDisplayPlanDeviceSnapshot(_plan, binding.device, renderedAtMs, nowMs);
    const target = binding.valueEl;
    target.textContent = formatDeviceOverview(displayDev).statusMsg;
  });
};

const renderPlanAt = (plan: PlanSnapshot | null, renderedAtMs: number, nowMs: number) => {
  resetLiveBindings();
  planList.innerHTML = '';
  if (!plan) {
    planEmpty.hidden = false;
    planEmpty.textContent = 'No plan available yet. Send power data or refresh devices.';
    planMeta.textContent = 'Awaiting data…';
    return;
  }
  liveMetaBinding = renderPlanMeta(planMeta, plan.meta, nowMs);

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
    planList.appendChild(buildPlanRow(plan, dev, renderedAtMs, nowMs));
  });
};

const livePlanController = createLivePlanController<PlanSnapshot>({
  hasLiveUpdates: (plan, renderedAtMs) => planNeedsLiveUpdates(plan, renderedAtMs),
  isVisible: isOverviewVisible,
  render: (plan, renderedAtMs, nowMs) => {
    renderPlanAt(plan, renderedAtMs, nowMs);
  },
  update: (plan, renderedAtMs, nowMs) => {
    updateLivePlanAt(plan, renderedAtMs, nowMs);
  },
});

export const renderPlan = (plan: PlanSnapshot | null) => {
  livePlanController.renderPlan(plan);
};

export const refreshPlan = async () => {
  const plan = await getPlanSnapshot();
  renderPlan(plan);
};

export type { PlanSnapshot };
