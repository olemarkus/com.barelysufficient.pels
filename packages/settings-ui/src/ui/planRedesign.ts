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
import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';
import { callApi, getApiReadModel } from './homey.ts';
import { getHomeScope } from './homeScope.ts';
import { readAreaSimulationPosture, readOverviewPlan } from './overviewPlanRead.ts';
import { readUsagePower } from './usagePowerRead.ts';
import { getPricesReadModel } from './prices.ts';
import { renderPlanOverview } from './views/PlanOverview.tsx';
import { planNeedsLiveUpdates } from './planLiveData.ts';
import { parsePlanSnapshot } from './planSnapshotParse.ts';
import { registerPlanSurfaceRenderer } from './planSurfaceRefresh.ts';
import { state } from './state.ts';
import {
  resolveOverviewSmartTaskRow,
  type OverviewSmartTaskRow,
  type OverviewSmartTaskStatusInput,
} from '../../../shared-domain/src/overviewSmartTaskRow.ts';
import { flattenPlanHistoryEntries, resolveMissStreakBadges } from '../../../shared-domain/src/deferredPlanHistory.ts';
import { resolveSmartTaskListStatus } from '../../../shared-domain/src/deadlineLabels.ts';
import type { PlanSnapshot } from './planTypes.ts';
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

const getPlanSnapshotFromPayload = (payload: SettingsUiPlanPayload | null | undefined): PlanSnapshot | null => (
  parsePlanSnapshot(payload?.plan)
);

// Whole-home only, deliberately: this reader collapses the payload to
// `PlanSnapshot | null`, so an `unavailable` scoped read would masquerade as
// "no plan committed yet". A selected meter area reads through
// `readOverviewPlan` (`overviewPlanRead.ts`), which discriminates
// `payload.homeScope` before any flat field is reachable.
const getPlanSnapshot = async (): Promise<PlanSnapshot | null> => (
  getPlanSnapshotFromPayload(await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH))
);

/**
 * Which home the COMMITTED render state (`currentPlan`, `cachedPowerStatus`,
 * `cachedSolarNowInput`) describes. One owner, three consequences in
 * `doRender`:
 *
 * - `area` + `read: 'unavailable'` renders the honest notice instead of the
 *   hero and cards — never fabricated numbers for a home the runtime could
 *   not serve;
 * - the smart-task row renders under Main only (smart tasks are a Main-home
 *   feature — locked multi-home decision, same as the daily budget);
 * - the hero's simulation context comes from the shown home's OWN flag
 *   (`simulating` for an area, `state.dryRun` for Main).
 */
type OverviewScope =
  | { kind: 'main' }
  | { kind: 'area'; homeId: string; read: 'pending' | 'served' | 'unavailable'; simulating: boolean };

let overviewScope: OverviewScope = { kind: 'main' };

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
    scopeUnavailable: overviewScope.kind === 'area' && overviewScope.read === 'unavailable',
    power: cachedPowerStatus,
    prices: cachedPrices,
    solarNowInput: cachedSolarNowInput,
    // Smart tasks are a Main-home feature (locked multi-home decision):
    // under a meter area the row is OMITTED as not-applicable — rendering
    // Main's task states under the area's name would break the scope bar's
    // honesty claim.
    smartTaskRow: overviewScope.kind === 'main' ? resolveSmartTaskRow(now) : null,
    context: {
      dryRun: overviewScope.kind === 'main' ? state.dryRun : overviewScope.simulating,
    },
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

const commitPlan = (plan: PlanSnapshot | null, scope: OverviewScope) => {
  overviewScope = scope;
  currentPlan = plan;
  currentRenderedAtMs = Date.now();
  planPayloadReceived = true;
  doRender();
};

/**
 * MAIN-stream entry point — the realtime `plan_updated` push and the rescue
 * gate's deferred repaint, both of which only ever carry the MAIN home's plan
 * (`plan_updated` is deliberately never widened to sub-homes).
 *
 * THE bare-URI-prime guard (multi-home): that push also re-seeds the bare
 * `/ui_plan` cache entry with Main's payload. While a meter area is the
 * selected scope this paint must be DROPPED — Main's device set rendered
 * under the area's name would be the exact lie the scope bar promises not to
 * tell. The area keeps reading through its `?homeId=` URI (the prime cannot
 * reach it) and its own freshness rides the suffixed `pels_status:<homeId>`
 * settings stream, routed in `settingsChangeRouter.ts`. The guard also drops
 * a stale Main read that resolves after the user switched scope mid-flight.
 */
export const renderPlan = (plan: PlanSnapshot | null) => {
  if (getHomeScope().selectedHomeId !== MAIN_HOME_ID) return;
  commitPlan(plan, { kind: 'main' });
};

/**
 * Blank the surface back to the loading skeleton for a just-picked scope.
 * Called by the scope subscription BEFORE the new home's read resolves, so
 * the previous home's numbers never sit under the new home's name — a wrong
 * home's data labelled with the new one is worse than a moment of skeleton.
 */
export const resetPlanSurfaceForScopeChange = (): void => {
  const { selectedHomeId } = getHomeScope();
  overviewScope = selectedHomeId === MAIN_HOME_ID
    ? { kind: 'main' }
    : { kind: 'area', homeId: selectedHomeId, read: 'pending', simulating: false };
  currentPlan = null;
  planPayloadReceived = false;
  cachedPowerStatus = null;
  cachedSolarNowInput = null;
  doRender();
};

/**
 * Activation-path twin of the scope subscription's reset (`uiRefreshTasks.ts`):
 * that subscriber only fires while the Overview is VISIBLE, so a home picked
 * while the panel was hidden leaves the previous home's committed render
 * behind. The Overview activation hook calls this AFTER the roster settles (a
 * persisted pick or a deleted-area reconcile can move the selection again) and
 * BEFORE the scoped refresh, so the stale home's hero/cards never sit under
 * the new home's scope bar while the reads are in flight. No-op when the
 * committed state already describes the selected home — an ordinary reopen
 * keeps its instant repaint instead of flashing the skeleton.
 */
export const resetPlanSurfaceIfScopeChanged = (): void => {
  const renderedHomeId = overviewScope.kind === 'main' ? MAIN_HOME_ID : overviewScope.homeId;
  if (renderedHomeId === getHomeScope().selectedHomeId) return;
  resetPlanSurfaceForScopeChange();
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
//
// MAIN-stream entry point, exactly like `renderPlan`: `power_updated` is
// Main's push and is never widened, so while a meter area is the selected
// scope it must NOT stomp the area's cached hero status (freshness, solar,
// shortfall) with Main's. The area's status arrives through its own scoped
// `ui_power` read instead.
export const updatePlanPower = (
  power: SettingsUiPowerStatus | null,
  tracker?: SettingsUiPowerPayload['tracker'],
): void => {
  if (getHomeScope().selectedHomeId !== MAIN_HOME_ID) return;
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

// The scoped power read shared with the Usage surface (`readUsagePower`
// follows the same selected home), wrapped so a transport failure degrades to
// "no status" — the hero then falls back to the plan meta's own freshness
// fields, matching the Main path's `readPowerForPlanRefresh` catch.
const readScopedPowerForPlanRefresh = async (): Promise<PlanPowerRead> => {
  try {
    const read = await readUsagePower();
    if (read.state !== 'served') return { status: null, solarNowInput: null };
    return {
      status: read.payload.status ?? null,
      solarNowInput: toSolarNowInput(read.payload.tracker ?? null),
    };
  } catch {
    return { status: null, solarNowInput: null };
  }
};

// Monotonic run id covering BOTH `refreshPlan` branches (Main and area).
// Same-scope refreshes overlap freely — the Overview activation hook and a
// settings event both start one, and the home-id check cannot tell them apart
// — and a Main → area → Main round trip returns the scope to Main before an
// older Main refresh settles, so the identity check alone would admit its
// stale overwrite of a newer Main commit. Every refresh start bumps the one
// counter; only the newest-started refresh may commit (the `rosterGeneration`
// precedent in `homeScope.ts`).
let planRefreshGeneration = 0;

// One meter area's Overview refresh: that area's own scoped plan/power reads,
// discriminated before any flat field, plus its own simulation flag. Prices
// stay global — the price horizon is the whole home's (and the whole
// market's), so the anticipation subline renders under any scope.
const refreshAreaPlan = async (homeId: string): Promise<void> => {
  planRefreshGeneration += 1;
  const generation = planRefreshGeneration;
  const [planRead, power, prices, simulating] = await Promise.all([
    readOverviewPlan(),
    readScopedPowerForPlanRefresh(),
    readPricesForPlanRefresh(),
    readAreaSimulationPosture(homeId),
  ]);
  // Last-wins, two axes: the generation drops an older refresh (the scope
  // check alone admits a same-area overlap — the home id has not changed),
  // and the scope check drops a slow read for a scope the user has already
  // left (the mirror of `renderPlan`'s Main-stream guard).
  if (generation !== planRefreshGeneration) return;
  if (getHomeScope().selectedHomeId !== homeId) return;
  cachedPrices = prices;
  if (planRead.state === 'unavailable') {
    // The empty shape carries NO information about this home: render the
    // honest notice, never `plan: null` dressed as "no plan committed yet".
    cachedPowerStatus = null;
    cachedSolarNowInput = null;
    commitPlan(null, { kind: 'area', homeId, read: 'unavailable', simulating });
    return;
  }
  cachedPowerStatus = power.status;
  cachedSolarNowInput = power.solarNowInput;
  // The reader already resolved the payload to a snapshot: a `served` plan is
  // either a valid snapshot or a genuine "no plan committed yet". Re-parsing
  // here would re-validate a typed invariant the producer owns.
  commitPlan(planRead.payload.plan, { kind: 'area', homeId, read: 'served', simulating });
};

export const refreshPlan = async () => {
  const { selectedHomeId } = getHomeScope();
  if (selectedHomeId !== MAIN_HOME_ID) {
    // The plan-history fetch feeds the smart-task row's miss-streak variant —
    // a Main-home surface the area render omits, so skip the fetch too.
    await refreshAreaPlan(selectedHomeId);
    return;
  }
  planRefreshGeneration += 1;
  const generation = planRefreshGeneration;
  refreshPlanHistoryInBackground();
  const [plan, power, prices] = await Promise.all([
    getPlanSnapshot(),
    readPowerForPlanRefresh(),
    readPricesForPlanRefresh(),
  ]);
  // Last-wins, two axes (the area branch's mirror). The generation drops an
  // older Main refresh that a scope round trip (Main → area → Main) or a
  // same-scope overlap would otherwise let overwrite a newer commit — the
  // identity check below passes for both. The scope check drops a Main read
  // that resolves after the user switched to an area mid-flight, cache writes
  // included — `renderPlan`'s guard alone would leave Main's power status
  // cached for the area's next live-tick repaint.
  if (generation !== planRefreshGeneration) return;
  if (getHomeScope().selectedHomeId !== MAIN_HOME_ID) return;
  cachedPowerStatus = power.status;
  cachedSolarNowInput = power.solarNowInput;
  cachedPrices = prices;
  renderPlan(plan);
};

export type { PlanSnapshot };
