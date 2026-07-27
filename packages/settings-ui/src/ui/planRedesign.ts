import './materialWeb.ts';
import {
  SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  type SettingsUiDeferredObjectivePlanHistoryPayload,
  type SettingsUiPlanPayload,
  type SettingsUiPowerPayload,
  type SettingsUiPowerStatus,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi, getApiReadModel } from './homey.ts';
import { getPricesReadModel } from './prices.ts';
import { renderPlanOverview } from './views/PlanOverview.tsx';
import { planNeedsLiveUpdates } from './planLiveData.ts';
import { registerPlanSurfaceRenderer } from './planSurfaceRefresh.ts';
import { state } from './state.ts';
import {
  resolveOverviewSmartTaskRow,
  type OverviewSmartTaskRow,
  type OverviewSmartTaskStatusInput,
} from '../../../shared-domain/src/overviewSmartTaskRow.ts';
import { flattenPlanHistoryEntries, resolveMissStreakBadges } from '../../../shared-domain/src/deferredPlanHistory.ts';
import { resolveSmartTaskListStatus } from '../../../shared-domain/src/deadlineLabels.ts';
import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';
import type { SolarNowInput } from '../../../shared-domain/src/solar/solarNow.ts';

let cachedPowerStatus: SettingsUiPowerStatus | null = null;
// Raw triple for the hero's "Solar now" subline; resolution (finiteness +
// staleness + materiality gates) happens in `resolveSolarNow` at render time
// so the line disappears on its own once the sample goes stale.
let cachedSolarNowInput: SolarNowInput | null = null;
let cachedPrices: SettingsUiPricesPayload | null = null;
// Miss-streak badges for the smart-task row, derived once per history fetch
// (same `/ui_deferred_objective_history` payload the Smart-tasks list reads)
// and kept null-tolerant: a failed read renders the row without the miss
// variant rather than blocking the overview. Pre-resolved here — not in
// `resolveSmartTaskRow` — because `doRender` can run on a 1 s live tick and
// re-flattening/sorting the whole archive per tick is avoidable work.
let cachedMissStreaks: ReturnType<typeof resolveMissStreakBadges> = [];
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

// Whole-home only, deliberately: this reader collapses the payload to
// `PlanSnapshot | null`, so an `unavailable` scoped read would masquerade as
// "no plan committed yet". The scope-selector PR adds a scoped reader that
// discriminates `payload.homeScope` first (see TODO.md).
const getPlanSnapshot = async (): Promise<PlanSnapshot | null> => (
  getPlanSnapshotFromPayload(await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH))
);

const toSolarNowInput = (tracker: SettingsUiPowerPayload['tracker']): SolarNowInput | null => (
  tracker && typeof tracker === 'object'
    ? {
      lastPowerW: tracker.lastPowerW,
      lastGenerationW: tracker.lastGenerationW,
      lastTimestamp: tracker.lastTimestamp,
    }
    : null
);

type PlanPowerRead = {
  status: SettingsUiPowerStatus | null;
  solarNowInput: SolarNowInput | null;
};

const readPowerForPlanRefresh = async (): Promise<PlanPowerRead> => {
  try {
    const payload = await getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH);
    return { status: payload?.status ?? null, solarNowInput: toSolarNowInput(payload?.tracker ?? null) };
  } catch {
    return { status: null, solarNowInput: null };
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
    solarNowInput: cachedSolarNowInput,
    smartTaskRow: resolveSmartTaskRow(now),
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

// `tracker === undefined` means the realtime push carried no full tracker —
// keep the cached solar triple (the resolver's staleness gate retires it on
// its own); an explicit tracker (or null) replaces it.
export const updatePlanPower = (
  power: SettingsUiPowerStatus | null,
  tracker?: SettingsUiPowerPayload['tracker'],
): void => {
  cachedPowerStatus = power;
  if (tracker !== undefined) {
    cachedSolarNowInput = toSolarNowInput(tracker);
  }
  doRender();
};

const readPricesForPlanRefresh = async (): Promise<SettingsUiPricesPayload | null> => {
  try {
    return await getPricesReadModel();
  } catch {
    return null;
  }
};

// Fire-and-forget history refresh: the row's miss-streak variant is optional
// context, so a slow or retrying `/ui_deferred_objective_history` read must
// never delay the main Overview refresh (plan/power/prices). Uncached read
// (the same contract the Smart-tasks list uses): nothing invalidates a cached
// history payload when a run finalizes. Last-wins guarded so an older slow
// read can't overwrite a fresher one; repaints when the badges land.
let historyRefreshSequence = 0;
const refreshPlanHistoryInBackground = (): void => {
  historyRefreshSequence += 1;
  const sequence = historyRefreshSequence;
  void (async () => {
    let payload: SettingsUiDeferredObjectivePlanHistoryPayload | null;
    try {
      payload = await callApi<SettingsUiDeferredObjectivePlanHistoryPayload>(
        'GET',
        SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
      );
    } catch {
      payload = null;
    }
    if (sequence !== historyRefreshSequence) return;
    cachedMissStreaks = resolveMissStreakBadges(flattenPlanHistoryEntries(payload));
    doRender();
  })();
};

const formatRowTime = (ms: number): string => (
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
);

// Per-task status inputs for the Overview smart-task row, derived from the
// SAME state the device cards read (`state.deferredObjectiveActivePlans` +
// `state.deferredObjectiveSettings`) via the SAME `resolveSmartTaskListStatus`
// the Smart-tasks list card uses — one status vocabulary, two surfaces.
const toRowStatus = (params: {
  deviceId: string;
  plan: NonNullable<typeof state.deferredObjectiveActivePlans>['plansByDeviceId'][string];
  deadlineAtMs: number;
  nowMs: number;
}): OverviewSmartTaskStatusInput => {
  const { deviceId, plan, deadlineAtMs, nowMs } = params;
  const planDevice = currentPlan?.devices?.find((dev) => dev.id === deviceId);
  return {
    deviceName: planDevice?.name ?? plan.deviceName ?? deviceId,
    statusId: resolveSmartTaskListStatus({
      pending: plan.pending || plan.latest === null,
      pendingReason: plan.pendingReason,
      diagnosticReasonCode: plan.diagnosticReasonCode,
      planStatus: plan.latest?.planStatus,
      firstActionAtMs: Array.isArray(plan.latest?.hours)
        ? plan.latest.hours[0]?.startsAtMs ?? null
        : null,
      nowMs,
    }),
    // The status derives from the recorded PLAN, so the ETA prefers the
    // plan's own deadline: after a deadline edit the settings blob reloads
    // before the recorder replans, and mixing the fresh settings deadline
    // with the old plan's status would pair a wrong time with the verdict.
    deadlineAtMs: Number.isFinite(plan.deadlineAtMs) ? plan.deadlineAtMs : deadlineAtMs,
  };
};

const resolveRowStatuses = (nowMs: number): OverviewSmartTaskStatusInput[] => {
  const plans = state.deferredObjectiveActivePlans?.plansByDeviceId ?? {};
  const statuses: OverviewSmartTaskStatusInput[] = [];
  for (const [deviceId, plan] of Object.entries(plans)) {
    const objective = state.deferredObjectiveSettings?.objectivesByDeviceId?.[deviceId];
    if (!objective?.enabled) continue;
    if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= nowMs) continue;
    statuses.push(toRowStatus({ deviceId, plan, deadlineAtMs: objective.deadlineAtMs, nowMs }));
  }
  return statuses;
};

const resolveSmartTaskRow = (nowMs: number): OverviewSmartTaskRow | null => (
  resolveOverviewSmartTaskRow({
    statuses: resolveRowStatuses(nowMs),
    missStreaks: cachedMissStreaks,
    formatTime: formatRowTime,
  })
);

// Refreshes the overview hero's price-dependent state (e.g. the "Cheapest hour
// ahead …" anticipation subline) when the runtime broadcasts `prices_updated`.
// The plan snapshot itself is not re-fetched — only the cached prices are
// refreshed and the surface is re-rendered against the current plan.
export const updatePlanPrices = async (): Promise<void> => {
  cachedPrices = await readPricesForPlanRefresh();
  doRender();
};

export const refreshPlan = async () => {
  refreshPlanHistoryInBackground();
  const [plan, power, prices] = await Promise.all([
    getPlanSnapshot(),
    readPowerForPlanRefresh(),
    readPricesForPlanRefresh(),
  ]);
  cachedPowerStatus = power.status;
  cachedSolarNowInput = power.solarNowInput;
  cachedPrices = prices;
  renderPlan(plan);
};

export type { PlanSnapshot };
