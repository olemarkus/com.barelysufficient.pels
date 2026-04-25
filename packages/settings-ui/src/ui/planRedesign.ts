import './materialWeb.ts';
import { planCards, planEmpty } from './dom.ts';
import {
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  type SettingsUiPlanPayload,
  type SettingsUiPowerPayload,
  type SettingsUiPowerStatus,
} from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel } from './homey.ts';
import { createLivePlanController } from './planLive.ts';
import { planNeedsLiveUpdates, resolveDisplayPlanDevices } from './planLiveData.ts';
import { renderPlanHero, renderPlanHourStrip } from './planHero.ts';
import { buildPlanCard, updatePlanCardBinding } from './planDeviceCard.ts';
import type { PlanDeviceSnapshot, PlanSnapshot, PlanStatusBinding } from './planTypes.ts';

let liveStatusBindings: PlanStatusBinding[] = [];
let cachedOverviewPanel: Element | null = null;
let hasCachedOverviewPanel = false;
let lastRenderedPlan: PlanSnapshot | null = null;
let lastRenderedAtMs = 0;
let cachedPowerStatus: SettingsUiPowerStatus | null = null;

const hasStructuredReason = (value: unknown): boolean => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as { code?: unknown }).code === 'string'
);

const isPlanDeviceSnapshot = (value: unknown): value is PlanDeviceSnapshot => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { name?: unknown }).name === 'string'
  && hasStructuredReason((value as { reason?: unknown }).reason)
);

export const parsePlanSnapshot = (value: unknown): PlanSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const devices = (value as { devices?: unknown }).devices;
  if (devices !== undefined && (!Array.isArray(devices) || !devices.every(isPlanDeviceSnapshot))) {
    return null;
  }
  return value as PlanSnapshot;
};

const getPlanSnapshotFromPayload = (payload: SettingsUiPlanPayload | null | undefined): PlanSnapshot | null => (
  parsePlanSnapshot(payload?.plan)
);

const getPlanSnapshot = async (): Promise<PlanSnapshot | null> => (
  getPlanSnapshotFromPayload(await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH))
);

const readPowerStatus = async (): Promise<SettingsUiPowerStatus | null> => {
  const payload = await getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH);
  return payload?.status ?? null;
};

const readPowerStatusForPlanRefresh = async (): Promise<SettingsUiPowerStatus | null> => {
  try {
    return await readPowerStatus();
  } catch {
    return null;
  }
};

const resetLiveBindings = () => {
  liveStatusBindings = [];
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

const updateLivePlanAt = (plan: PlanSnapshot | null, renderedAtMs: number, nowMs: number) => {
  lastRenderedPlan = plan;
  lastRenderedAtMs = renderedAtMs;
  const devices = Array.isArray(plan?.devices) ? plan.devices : [];
  const displayDevices = resolveDisplayPlanDevices(plan, devices, renderedAtMs, nowMs);
  renderPlanHero(plan?.meta, displayDevices, cachedPowerStatus, nowMs);
  renderPlanHourStrip(plan?.meta);
  for (let i = 0; i < liveStatusBindings.length; i += 1) {
    updatePlanCardBinding(liveStatusBindings[i], plan, renderedAtMs, nowMs);
  }
};

const renderPlanAt = (plan: PlanSnapshot | null, renderedAtMs: number, nowMs: number) => {
  lastRenderedPlan = plan;
  lastRenderedAtMs = renderedAtMs;
  resetLiveBindings();
  planCards.replaceChildren();
  if (!plan) {
    renderPlanHero(undefined, [], cachedPowerStatus, nowMs);
    renderPlanHourStrip(undefined);
    planEmpty.hidden = false;
    planEmpty.textContent = 'No plan available yet. Send power data or refresh devices.';
    return;
  }

  const devices = Array.isArray(plan.devices) ? plan.devices : [];
  const sortedDevices = [...devices].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  const displayDevices = resolveDisplayPlanDevices(plan, sortedDevices, renderedAtMs, nowMs);
  renderPlanHero(plan.meta, displayDevices, cachedPowerStatus, nowMs);
  renderPlanHourStrip(plan.meta);
  if (devices.length === 0) {
    planEmpty.hidden = false;
    planEmpty.textContent = 'No managed devices.';
    return;
  }

  planEmpty.hidden = true;
  sortedDevices.forEach((dev) => {
    const { el, statusBinding } = buildPlanCard(plan, dev, renderedAtMs, nowMs);
    liveStatusBindings.push(statusBinding);
    planCards.appendChild(el);
  });
};

const livePlanController = createLivePlanController<PlanSnapshot>({
  hasLiveUpdates: (plan, renderedAtMs, nowMs) => planNeedsLiveUpdates(plan, renderedAtMs, nowMs),
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

export const updatePlanPower = (power: SettingsUiPowerStatus | null): void => {
  cachedPowerStatus = power;
  if (!lastRenderedPlan) return;
  const nowMs = Date.now();
  const devices = Array.isArray(lastRenderedPlan.devices) ? lastRenderedPlan.devices : [];
  const sortedDevices = [...devices].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  const displayDevices = resolveDisplayPlanDevices(lastRenderedPlan, sortedDevices, lastRenderedAtMs || nowMs, nowMs);
  renderPlanHero(lastRenderedPlan.meta, displayDevices, cachedPowerStatus, nowMs);
};

export const refreshPlan = async () => {
  const planPromise: Promise<PlanSnapshot | null> = getPlanSnapshot();
  const powerPromise: Promise<SettingsUiPowerStatus | null> = readPowerStatusForPlanRefresh();
  const [plan, power] = await Promise.all([planPromise, powerPromise]);
  cachedPowerStatus = power;
  renderPlan(plan);
};

export type { PlanSnapshot };
