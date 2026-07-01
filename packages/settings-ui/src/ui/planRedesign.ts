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
import { registerPlanSurfaceRenderer } from './planSurfaceRefresh.ts';
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

// Whether the static first-paint skeleton in `#plan-redesign-surface`
// (hero shimmer + the two `data-overview-cards-placeholder` card shims in
// index.html) has been cleared. Preact's first render into a non-empty
// container tries to ADOPT the existing nodes as its own tree, which used to
// strand the static `#plan-cards` + placeholder as ghost cards below the real
// device list. The clear happens on the FIRST render, whatever triggers it —
// which can be a pre-payload render (`bumpPlanSurface` / `updatePlanPower`
// run `doRender` before the first plan fetch resolves). That is safe: with
// `plan === null` PlanHero renders the same skeleton markup as the static
// one, and the "No plan available yet" empty state is gated on
// `planPayloadReceived` so a slow boot keeps showing the skeleton instead of
// a premature empty-state verdict.
let surfaceSkeletonCleared = false;

// True once a plan payload has been DELIVERED (`renderPlan` ran; the payload
// itself may legitimately be null, meaning the runtime has no plan yet).
// Gates the Overview empty-state copy — before the first delivery the
// surface shows the loading skeleton, not "No plan available yet…".
let planPayloadReceived = false;

const doRender = () => {
  const surface = getPlanSurface();
  if (!surface) return;
  if (!surfaceSkeletonCleared) {
    surface.replaceChildren();
    surfaceSkeletonCleared = true;
  }
  const now = Date.now();
  renderPlanOverview(surface, {
    plan: currentPlan,
    planResolved: planPayloadReceived,
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
  planPayloadReceived = true;
  doRender();
};

export const bumpPlanSurface = (): void => {
  doRender();
};

// Expose the render to controllers via the leaf refresh module, so they can
// refresh after a write without importing this orchestrator (avoids a
// view → controller → orchestrator cycle). See planSurfaceRefresh.ts.
registerPlanSurfaceRenderer(doRender);

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

// Refreshes the overview hero's price-dependent state (e.g. the "Cheapest hour
// ahead …" anticipation subline) when the runtime broadcasts `prices_updated`.
// The plan snapshot itself is not re-fetched — only the cached prices are
// refreshed and the surface is re-rendered against the current plan.
export const updatePlanPrices = async (): Promise<void> => {
  cachedPrices = await readPricesForPlanRefresh();
  doRender();
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
