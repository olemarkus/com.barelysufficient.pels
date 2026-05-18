import './materialWeb.ts';
import {
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  type SettingsUiPlanPayload,
  type SettingsUiPowerPayload,
  type SettingsUiPowerStatus,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel } from './homey.ts';
import { getPricesReadModel } from './prices.ts';
import { renderPlanOverview } from './views/PlanOverview.tsx';
import { planNeedsLiveUpdates } from './planLiveData.ts';
import { state } from './state.ts';
import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';

let cachedPowerStatus: SettingsUiPowerStatus | null = null;
let cachedPrices: SettingsUiPricesPayload | null = null;
let currentPlan: PlanSnapshot | null = null;
let currentRenderedAtMs = 0;
let liveTickInterval: ReturnType<typeof setInterval> | null = null;
let planSurface: HTMLElement | null = null;

const getPlanSurface = (): HTMLElement | null => (
  planSurface ??= document.getElementById('plan-redesign-surface')
);

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

const doRender = () => {
  const surface = getPlanSurface();
  if (!surface) return;
  const now = Date.now();
  renderPlanOverview(surface, {
    plan: currentPlan,
    power: cachedPowerStatus,
    prices: cachedPrices,
    context: { dryRun: state.dryRun },
    renderedAtMs: currentRenderedAtMs,
    nowMs: now,
  });
  const needsLive = planNeedsLiveUpdates(currentPlan, currentRenderedAtMs, now);
  if (needsLive && liveTickInterval === null) {
    liveTickInterval = setInterval(doRender, 1000);
  } else if (!needsLive && liveTickInterval !== null) {
    clearInterval(liveTickInterval);
    liveTickInterval = null;
  }
};

export const renderPlan = (plan: PlanSnapshot | null) => {
  currentPlan = plan;
  currentRenderedAtMs = Date.now();
  doRender();
};

export const bumpPlanSurface = (): void => {
  doRender();
};

export const updatePlanPower = (power: SettingsUiPowerStatus | null): void => {
  cachedPowerStatus = power;
  doRender();
};

const readPricesForPlanRefresh = async (): Promise<SettingsUiPricesPayload | null> => {
  try {
    return await getPricesReadModel();
  } catch {
    return null;
  }
};

export const refreshPlan = async () => {
  const [plan, power, prices] = await Promise.all([
    getPlanSnapshot(),
    readPowerStatusForPlanRefresh(),
    readPricesForPlanRefresh(),
  ]);
  cachedPowerStatus = power;
  cachedPrices = prices;
  renderPlan(plan);
};

export type { PlanSnapshot };
