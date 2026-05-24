import type {
  SettingsUiBootstrap,
  SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveSettingsEntry,
} from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import {
  deadlineLabels,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
  type DeadlineLabels,
  type DeadlineLiveState,
  type DeadlinePendingContext,
  type DeadlinePendingPriceSource,
  type DeadlinePlanPendingReason,
  type DeadlinePlanUnavailableReason,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { buildPlanInputs, resolveKwhPerUnitDisplayRate } from './deadlinePlanInputs.ts';
import { buildHero, resolveHeroTone } from './deadlinePlanHero.ts';
import {
  formatDeadlineFull,
  formatDeadlineShort,
  formatHourLabel,
  formatTarget,
  formatTemperature,
} from './deadlinePlanFormatters.ts';
import { resolveCostDisplayFromCombinedPrices, resolvePriceUnitLabel } from './priceUnit.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import {
  collectHorizonHours,
  ONE_HOUR_MS,
  type HorizonHour,
} from './deadlinePlanData.ts';
import {
  resolveEnergyNeededKWh,
  resolveProfile,
  resolveProgress,
} from './deadlinePlanResolvers.ts';
import {
  renderDeadlinePlan,
  type DeadlinePlanLoadState,
  type DeadlinePlanPayload,
  type DeadlinePlanPendingPayload,
} from './views/DeadlinePlan.tsx';
import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanRevisionReason,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';

type ObjectivePlanInput = {
  bootstrap: SettingsUiBootstrap;
  deviceId: string | null;
  devices: TargetDeviceSnapshot[];
  prices: SettingsUiPricesPayload;
  nowMs?: number;
};

const formatPrice = (total: number): string => total.toFixed(2);

// Pending heroes share the hero chip ordering `[kind, state, …]`. The state
// chip uses the same shared label map as the live hero so the three Smart-
// task surfaces (list / hero / device card) never disagree on chip copy.
const resolvePendingLiveState = (reason: DeadlinePlanPendingReason): DeadlineLiveState => {
  if (reason === 'invalid_session') return 'paused_unplugged';
  return 'building_plan';
};

// Pending-hero state chip tone, routed through the same
// `SMART_TASK_LIST_STATUS_CHIP_VARIANT` map the list card reads so the
// "Building plan…" / "Paused — unplugged" pill never shows a different
// colour on the list and the detail surface (per TODO 2163 — the prior
// `'info'`-vs-`'muted'` drift on `Building plan…` flagged in release
// review). The pending hero only ever resolves to `building_plan` /
// `paused_unplugged` via `resolvePendingLiveState`; the broader
// `DeadlineLiveState` union (`active` / `queued` / `ok`) doesn't reach
// this resolver in practice, so the fallback simply mirrors the
// `building_plan` variant. The `as` casts narrow the variant union
// (`string`) to the chip-tone subset since the variant map is typed
// `Record<…, string>` for change resilience.
const pendingChipTone = (
  liveState: DeadlineLiveState,
): DeadlinePlanPendingPayload['hero']['chips'][number]['tone'] => {
  if (liveState === 'paused_unplugged') {
    return SMART_TASK_LIST_STATUS_CHIP_VARIANT.paused_unplugged as 'warn';
  }
  return SMART_TASK_LIST_STATUS_CHIP_VARIANT.building_plan as 'muted';
};

const resolveActualDeviceKwh = (params: {
  bootstrap: SettingsUiBootstrap;
  deviceId: string;
  startsAtMs: number;
}): number | null => {
  const bucketKey = new Date(params.startsAtMs).toISOString();
  const value = params.bootstrap.power.tracker?.deviceBuckets?.[params.deviceId]?.[bucketKey];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
};

const resolvePriceTone = (hour: HorizonHour): DeadlinePlanPayload['timeline']['hours'][number]['tone'] => {
  if (hour.isCheap === true) return 'cheap';
  if (hour.isExpensive === true) return 'expensive';
  return 'normal';
};

const buildTimeline = (params: {
  device: TargetDeviceSnapshot;
  bootstrap: SettingsUiBootstrap;
  deviceId: string;
  hours: HorizonHour[];
  originalChargeByStartMs: Map<number, number>;
  currentChargeByStartMs: Map<number, number>;
  latestRevisionReason: DeferredObjectiveActivePlanRevisionReason | null;
  progressStart: number;
  progressTarget: number;
  progressPerKWh: number;
  progressUnit: '°C' | '%';
  deadlineAtMs: number;
  costDisplay: CostDisplay;
}): DeadlinePlanPayload['timeline'] => {
  let projectedProgress = params.progressStart;
  const progressFloor = Math.min(
    params.progressStart,
    ...params.hours.map((hour) => {
      const currentKwh = params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
      return currentKwh > 0
        ? Math.min(params.progressTarget, params.progressStart + currentKwh * params.progressPerKWh)
        : params.progressStart;
    }),
  );
  const normalizedProgressFloor = params.progressUnit === '°C'
    ? Math.max(0, Math.floor((progressFloor - 1) / 5) * 5)
    : Math.max(0, Math.floor((progressFloor - 5) / 10) * 10);
  const progressCeilingLabel = params.progressUnit === '°C'
    ? formatTemperature(params.progressTarget)
    : `${Math.round(params.progressTarget)}%`;
  return {
    ariaLabel: `Smart task schedule for ${formatDisplayDeviceName(params.device.name)}`,
    progressFloor: Math.min(normalizedProgressFloor, params.progressTarget - 1),
    progressCeilingValue: params.progressTarget,
    progressCeilingLabel,
    deadlineLabel: formatDeadlineShort(params.deadlineAtMs),
    hours: params.hours.map((hour) => {
      const originalKwh = params.originalChargeByStartMs.get(hour.startsAtMs) ?? 0;
      const currentKwh = params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
      if (currentKwh > 0) {
        projectedProgress = Math.min(params.progressTarget, projectedProgress + currentKwh * params.progressPerKWh);
      }
      const displayPrice = hour.price / Math.max(1, params.costDisplay.divisor);
      const hourChanged = Math.abs(originalKwh - currentKwh) > 0.001;
      return {
        time: formatHourLabel(hour.startsAtMs),
        price: formatPrice(displayPrice),
        priceValue: displayPrice,
        tone: resolvePriceTone(hour),
        planned: currentKwh > 0,
        changed: hourChanged,
        revisionReason: hourChanged ? params.latestRevisionReason : null,
        usage: {
          backgroundKwh: Math.max(0, hour.plannedOtherKWh),
          originalDeviceKwh: originalKwh,
          deviceKwh: currentKwh,
          actualDeviceKwh: resolveActualDeviceKwh({
            bootstrap: params.bootstrap,
            deviceId: params.deviceId,
            startsAtMs: hour.startsAtMs,
          }),
        },
        progress: projectedProgress,
      };
    }),
  };
};

type ResolvedObjectiveContext = {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  deviceId: string;
  deadlineAtMs: number;
  activePlan: DeferredObjectiveActivePlanV1 | null;
  nowMs: number;
};

type ResolvedContextResult =
  | { kind: 'active'; context: ResolvedObjectiveContext }
  | { kind: 'completed'; objectiveKind: DeferredObjectiveSettingsEntry['kind'] }
  | { kind: 'absent' };

const resolveObjectiveContext = (params: ObjectivePlanInput): ResolvedContextResult => {
  const nowMs = params.nowMs ?? Date.now();
  const deviceId = params.deviceId?.trim();
  if (!deviceId) return { kind: 'absent' };
  const settings = normalizeDeferredObjectiveSettings(params.bootstrap.settings.deferred_objectives);
  const objective = settings.objectivesByDeviceId[deviceId];
  const device = params.devices.find((candidate) => candidate.id === deviceId);
  if (!objective || !device) return { kind: 'absent' };
  const activePlan = params.bootstrap.deferredObjectiveActivePlans?.plansByDeviceId[deviceId] ?? null;
  const deadlineAtMs = activePlan?.deadlineAtMs ?? objective.deadlineAtMs;
  if (!Number.isFinite(deadlineAtMs)) return { kind: 'absent' };
  // Deadline already passed: runtime auto-disables on pass, so a still-enabled
  // entry with a past deadline is the same lifecycle moment. Either way the
  // page should land on History rather than a stale current-plan card.
  if (deadlineAtMs <= nowMs) return { kind: 'completed', objectiveKind: objective.kind };
  // Future deadline but the user disabled it (e.g. cleared from the deadlines
  // list): no current plan to show, no useful history to surface. Fall through
  // to the absent path so the generic "no deadline" card renders instead of
  // misleading "Deadline complete" copy.
  if (!objective.enabled) return { kind: 'absent' };
  return { kind: 'active', context: { device, objective, deviceId, deadlineAtMs, activePlan, nowMs } };
};

const resolvePendingReason = (
  activePlan: DeferredObjectiveActivePlanV1 | null,
): DeadlinePlanPendingReason => activePlan?.pendingReason ?? 'awaiting_horizon_plan';

// Narrow the unknown `combinedPrices` payload to the two fields we care about
// for pending-hero copy. Returns 'unknown' / null when the payload is missing
// or unrecognised so the copy falls back to neutral wording. `deviceName` /
// `deadlineTime` are appended by `buildPendingPayload` once the resolved
// objective context is in hand — keeping the price-only fields here means
// `resolveRenderInput` can share one helper for the absent-plan and ready-
// but-no-prices branches.
const resolvePendingPriceContext = (prices: SettingsUiPricesPayload): Pick<
  DeadlinePendingContext, 'priceSource' | 'lastFetchedShort'
> => {
  const combined = prices.combinedPrices;
  if (!combined || typeof combined !== 'object') {
    return { priceSource: 'unknown', lastFetchedShort: null };
  }
  const record = combined as { priceScheme?: unknown; lastFetched?: unknown };
  return {
    priceSource: resolvePriceSource(record.priceScheme),
    lastFetchedShort: formatLastFetched(record.lastFetched),
  };
};

const resolvePriceSource = (scheme: unknown): DeadlinePendingPriceSource => {
  if (scheme === 'flow') return 'external_flow';
  if (scheme === 'norway' || scheme === 'homey') return 'managed';
  return 'unknown';
};

const formatLastFetched = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};

const buildPendingHero = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  labels: DeadlineLabels;
  deadlineAtMs: number;
  pendingReason: DeadlinePlanPendingReason;
  pendingContext: DeadlinePendingContext;
}): DeadlinePlanPendingPayload['hero'] => {
  const target = formatTarget(params.objective);
  const deadline = formatDeadlineFull(params.deadlineAtMs);
  const copy = params.labels.pendingHeroByReason[params.pendingReason](params.pendingContext);
  const liveState = resolvePendingLiveState(params.pendingReason);
  return {
    chips: [
      { text: params.labels.kindChipLabel, tone: 'info' },
      { text: params.labels.liveStateChipLabel[liveState], tone: pendingChipTone(liveState) },
    ],
    sectionLabel: params.labels.sectionLabel,
    headline: copy.headline,
    headlineReason: copy.headlineReason,
    subline: `${formatDisplayDeviceName(params.device.name)} • Target ${target} by ${deadline}`,
    metaLine: copy.body,
    recourse: copy.recourse,
  };
};

const buildPendingPayload = (
  ctx: ResolvedObjectiveContext,
  priceContext: Pick<DeadlinePendingContext, 'priceSource' | 'lastFetchedShort'>,
): DeadlinePlanPendingPayload => {
  const labels = deadlineLabels(ctx.objective.kind);
  // Resolve device + deadline strings on this side of the layer so shared-
  // domain copy helpers stay free of locale and Date helpers (same rule as
  // the queued-hero headlineReason resolver).
  const pendingContext: DeadlinePendingContext = {
    ...priceContext,
    deviceId: ctx.deviceId,
    deviceName: ctx.device.name ?? '',
    deadlineTime: formatHourLabel(ctx.deadlineAtMs),
  };
  return {
    kind: ctx.objective.kind,
    labels,
    hero: buildPendingHero({
      device: ctx.device,
      objective: ctx.objective,
      labels,
      deadlineAtMs: ctx.deadlineAtMs,
      pendingReason: resolvePendingReason(ctx.activePlan),
      pendingContext,
    }),
  };
};

const buildChargeByStartMs = (
  revision: DeferredObjectiveActivePlanRevisionV1 | null,
): Map<number, number> => {
  const out = new Map<number, number>();
  if (!revision) return out;
  for (const hour of revision.hours) {
    out.set(hour.startsAtMs, hour.plannedKWh);
  }
  return out;
};

type ObjectivePayloadResult =
  | { kind: 'ok'; payload: DeadlinePlanPayload }
  | { kind: 'unavailable'; reason: DeadlinePlanUnavailableReason }
  // Active plan exists but the UI lacks prices to render a timeline. The
  // caller routes this to the pending hero so the user sees the same "waiting
  // for prices" copy regardless of whether the recorder or the prices fetch
  // is behind.
  | { kind: 'awaiting_prices' };

type ObjectivePayloadReady = {
  ctx: ResolvedObjectiveContext;
  bootstrap: SettingsUiBootstrap;
  profile: ReturnType<typeof resolveProfile>;
  progress: NonNullable<ReturnType<typeof resolveProgress>>;
  hours: HorizonHour[];
  energy: ReturnType<typeof resolveEnergyNeededKWh>;
  costDisplay: CostDisplay;
  priceUnitLabel: string;
};

const prepareObjectivePayload = (
  params: ObjectivePlanInput,
): ObjectivePayloadReady | ObjectivePayloadResult | null => {
  const ctxResult = resolveObjectiveContext(params);
  if (ctxResult.kind !== 'active') return null;
  const ctx = ctxResult.context;
  // `resolveRenderInput` filters this out as `pending` before reaching here.
  // Reachable only via direct test calls to `buildObjectivePayload`; signal
  // "not renderable" rather than misleading `already_satisfied`.
  if (!ctx.activePlan?.latest) return null;

  const profile = resolveProfile(params.bootstrap.power.tracker, ctx.deviceId, ctx.objective.kind);
  const progress = resolveProgress({ device: ctx.device, objective: ctx.objective, profile });
  if (!progress) return { kind: 'unavailable', reason: 'no_current_reading' };
  if (progress.remainingUnits <= 0) return { kind: 'unavailable', reason: 'already_satisfied' };

  const windowStartMs = Math.min(ctx.nowMs, ctx.activePlan.original?.revisedAtMs ?? ctx.nowMs);
  const hours = collectHorizonHours({
    bootstrap: params.bootstrap,
    deadlineAtMs: ctx.deadlineAtMs,
    windowStartMs,
    prices: params.prices,
  });
  if (hours.length === 0) return { kind: 'awaiting_prices' };

  const costDisplay = resolveCostDisplayFromCombinedPrices(params.prices.combinedPrices);
  return {
    ctx,
    bootstrap: params.bootstrap,
    profile,
    progress,
    hours,
    energy: resolveEnergyNeededKWh({ profile, activePlan: ctx.activePlan }),
    costDisplay,
    priceUnitLabel: resolvePriceUnitLabel(costDisplay),
  };
};

// Producer-side guards for optional revision fields. Pulled out so
// `buildReadyPayload` stays under the cyclomatic-complexity ceiling — without
// these, every inline `typeof … && Number.isFinite(…) && …` branch ticks the
// complexity score even though the meaning is just "carry through when valid,
// null otherwise."
const resolvePositiveNumber = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

const resolveFiniteNumber = (value: number | null | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const resolveNonEmptyString = (value: string | undefined): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

// Resolves the live-derived cost + delivered-kWh fields piped into the hero.
// Sits next to `buildTimeline` because they consume the same per-hour shape;
// kept as a small helper so `buildReadyPayload` stays under the complexity
// ceiling and the live derivation has one home.
//
// Live derivation (no persistence): the active plan revisions carry hourly
// planned kWh; the power tracker carries hourly actual kWh per device. We
// scale `hour.price` by the cost-display divisor (same scaling the timeline
// uses) so the cost reads in the user's display currency unit.
const resolveLiveCostAndDelivery = (params: {
  bootstrap: SettingsUiBootstrap;
  deviceId: string;
  hours: HorizonHour[];
  currentChargeByStartMs: Map<number, number>;
  costDisplay: CostDisplay;
  // Plan start timestamp + render-time "now". Tracker buckets accumulate
  // incrementally during the current hour (see `lib/power/trackerEnergy.ts`),
  // so the bucket value represents `[hour_start, min(now, hour_end))` of
  // measured energy — not necessarily a full-hour aggregate. We prorate the
  // bucket by `relevant / elapsed`, where `relevant = min(now, hour_end) -
  // max(startedAtMs, hour_start)` and `elapsed = min(now, hour_end) - hour_start`.
  // Past closed hours have `elapsed = ONE_HOUR_MS`; current open hours have
  // `elapsed = now - hour_start` and the prorate becomes "fraction of the
  // already-elapsed slice that landed after `startedAtMs`".
  startedAtMs: number;
  nowMs: number;
}): {
  plannedTotalCost: number;
  deliveredCostSoFar: number | null;
  deliveredKWh: number;
} => {
  const divisor = Math.max(1, params.costDisplay.divisor);
  let plannedTotalCost = 0;
  let deliveredCostSoFar = 0;
  let deliveredKWh = 0;
  let sawAnyActual = false;
  for (const hour of params.hours) {
    const displayPrice = hour.price / divisor;
    const plannedKWh = params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
    if (plannedKWh > 0) plannedTotalCost += displayPrice * plannedKWh;
    const proratedKWh = resolveProratedActualKWh({
      bootstrap: params.bootstrap,
      deviceId: params.deviceId,
      hourStartsAtMs: hour.startsAtMs,
      startedAtMs: params.startedAtMs,
      nowMs: params.nowMs,
    });
    if (proratedKWh > 0) {
      sawAnyActual = true;
      deliveredCostSoFar += displayPrice * proratedKWh;
      deliveredKWh += proratedKWh;
    }
  }
  return {
    plannedTotalCost,
    deliveredCostSoFar: sawAnyActual ? deliveredCostSoFar : null,
    deliveredKWh,
  };
};

// Prorate one bucket's `actualKWh` against the plan's run interval. Tracker
// buckets accumulate incrementally so the value represents `[hour_start,
// min(now, hour_end))`. The relevant slice for delivered-so-far is
// `[max(startedAtMs, hour_start), min(now, hour_end))`. Returns 0 for any
// bucket that doesn't overlap the run interval, or whose tracker reading
// is missing / non-positive.
const resolveProratedActualKWh = (params: {
  bootstrap: SettingsUiBootstrap;
  deviceId: string;
  hourStartsAtMs: number;
  startedAtMs: number;
  nowMs: number;
}): number => {
  const hourEndMs = params.hourStartsAtMs + ONE_HOUR_MS;
  if (hourEndMs <= params.startedAtMs) return 0;
  const bucketCloseMs = Math.min(params.nowMs, hourEndMs);
  const elapsedMs = bucketCloseMs - params.hourStartsAtMs;
  const relevantMs = bucketCloseMs - Math.max(params.startedAtMs, params.hourStartsAtMs);
  if (elapsedMs <= 0 || relevantMs <= 0) return 0;
  const actualKWh = resolveActualDeviceKwh({
    bootstrap: params.bootstrap,
    deviceId: params.deviceId,
    startsAtMs: params.hourStartsAtMs,
  });
  if (actualKWh === null || actualKWh <= 0) return 0;
  return actualKWh * (relevantMs / elapsedMs);
};

// Flattens the resolver's energy result into the hero's range + chip inputs,
// defaulting when no learned/buffered energy is available (null `energy`).
const resolveHeroEnergyFields = (
  energy: ObjectivePayloadReady['energy'],
  energyNeededKWh: number,
): { energyExpectedKWh: number; learning: boolean } => ({
  energyExpectedKWh: energy?.energyExpectedKWh ?? energyNeededKWh,
  learning: energy?.learning ?? false,
});

const buildReadyPayload = (input: ObjectivePayloadReady): DeadlinePlanPayload => {
  const { ctx, bootstrap, profile, progress, hours, energy } = input;
  const { device, objective, deviceId, deadlineAtMs, activePlan, nowMs } = ctx;
  const latest = activePlan!.latest!;
  const labels = deadlineLabels(objective.kind);
  const energyNeededKWh = energy?.energyNeededKWh ?? 0;
  const heroEnergy = resolveHeroEnergyFields(energy, energyNeededKWh);
  const originalChargeByStartMs = buildChargeByStartMs(activePlan!.original ?? latest);
  const currentChargeByStartMs = buildChargeByStartMs(latest);
  const progressPerKWh = energyNeededKWh > 0 ? progress.remainingUnits / energyNeededKWh : 0;
  const cannotMeet = latest.planStatus === 'cannot_meet' || latest.planStatus === 'at_risk';
  const firstChargingHour = hours.find((hour) => currentChargeByStartMs.has(hour.startsAtMs));
  const hoursLeft = Math.max(0, Math.ceil((deadlineAtMs - nowMs) / ONE_HOUR_MS));
  const costAndDelivery = resolveLiveCostAndDelivery({
    bootstrap, deviceId, hours, currentChargeByStartMs, costDisplay: input.costDisplay,
    startedAtMs: activePlan!.startedAtMs,
    nowMs,
  });
  // Back-calculate `startProgress` from current − delivered × progressPerKWh
  // when both signals are available. `progressPerKWh = remainingUnits /
  // energyNeededKWh` simplifies to `1 / kWhPerUnit` (the inverse of the
  // learned/bootstrap rate), so this is the planner's view of progress made
  // per kWh delivered. Null when `progressPerKWh` is zero (no allocation /
  // already-satisfied path is gated earlier), no delivery has been observed,
  // or the back-calc lands negative (conservative rate over-counted progress)
  // — in any of those the delivered-so-far line falls back to the `now …`
  // phrasing rather than fabricating a `0 °C → current` arrow. Exactly zero
  // is preserved because `0 %` is a legitimate start for an empty EV battery
  // and `0 °C` is a real (if unusual) heater start; the bot's spurious-zero
  // case is already gated by `deliveredKWh <= 0`.
  const startProgress = (() => {
    if (progressPerKWh <= 0 || costAndDelivery.deliveredKWh <= 0) return null;
    const candidate = progress.currentValue - costAndDelivery.deliveredKWh * progressPerKWh;
    if (!Number.isFinite(candidate) || candidate < 0) return null;
    return candidate;
  })();
  // Older persisted revisions don't carry the count; treat absence as zero so
  // the budget-exhausted explanation only fires when the recorder actually
  // saw it. Two surfaces consume this signal:
  //   - The cannot-meet body copy + recourse fire on a budget-bound verdict.
  //     The producer-resolved `latest.floorShortfallCause === 'budget'` is the
  //     authoritative signal — it covers the per-bucket background-squeeze
  //     case (`dailyBudgetExhaustedBucketCount: 0`, prod Connected 300) the
  //     count-based heuristic misses. Per
  //     `feedback_layering_resolution_in_producer`, the consumer reads the
  //     flat producer field and stops; the legacy `at_risk && bucketCount > 0`
  //     clause is GATED on `floorShortfallCause === undefined` so it only
  //     fires for pre-v2.9.x revisions persisted before the producer field
  //     shipped — never as a consumer-side override of a producer verdict.
  //     The legacy clause is further restricted to `at_risk` (never
  //     `cannot_meet`): the producer only returns `cannot_meet` on the
  //     `!budgetBound` branch of `resolveStatus` in `horizonPlanner.ts`, so
  //     by construction a `cannot_meet` verdict's cause is `time_capacity`
  //     (or `step_power` / `estimate`), never `budget`. Pre-v2.9.x
  //     `cannot_meet` plans with cumulatively exhausted buckets reflect a
  //     physical/time miss that happened to also brush the budget cap on
  //     the way; routing them to "Open Budget" would misdirect the user.
  //     Once the recorder re-records each plan post-upgrade the producer
  //     field arrives and the gate becomes moot for that plan.
  //   - The queued headline-reason resolver fires on any plan status so a
  //     healthy on-track plan whose first hour falls after midnight can still
  //     surface "Today's budget is full — next cheap window after midnight."
  //     That continues to read `dailyBudgetExhaustedBucketCount > 0` because it
  //     asks a different question ("did the run-up have any exhausted
  //     buckets?") that's orthogonal to the current shortfall cause.
  const dailyBudgetExhaustedAnywhere = (latest.dailyBudgetExhaustedBucketCount ?? 0) > 0;
  const dailyBudgetExhausted = latest.floorShortfallCause === 'budget'
    || (latest.floorShortfallCause === undefined
      && latest.planStatus === 'at_risk'
      && dailyBudgetExhaustedAnywhere);
  const planningSpeedKw = resolvePositiveNumber(activePlan!.initialPlanningSpeedKw ?? latest.planningSpeedKw);

  return {
    kind: objective.kind,
    labels,
    priceUnitLabel: input.priceUnitLabel,
    hero: buildHero({
      device,
      deviceId,
      objective,
      labels,
      firstChargingHour,
      deadlineAtMs,
      energyNeededKWh,
      energyExpectedKWh: heroEnergy.energyExpectedKWh,
      hoursLeft,
      confidence: energy?.confidence ?? null,
      learning: heroEnergy.learning,
      planStatus: latest.planStatus,
      nowMs,
      cannotMeet,
      dailyBudgetExhausted,
      dailyBudgetExhaustedInRunUp: dailyBudgetExhaustedAnywhere,
      // Latest revision's `computedFromPricesUpTo` is carried verbatim so the
      // hero's headline-reason resolver can branch on "prices not through
      // deadline yet" without re-deriving the comparison at the view layer.
      computedFromPricesUpTo: resolveFiniteNumber(latest.computedFromPricesUpTo),
      // Plan-level snapshot frozen at first-revision time. Read from the
      // plan, not the latest revision, so the hero meta line shows the
      // "total duration" the user agreed to at plan creation rather than
      // shrinking as energy is consumed each cycle. Legacy persisted plans
      // (recorded before this snapshot shipped) fall back to the per-revision
      // values so the surface stays populated; the snapshot will land the
      // first time those plans hit a replan revision.
      planningSpeedKw,
      estimatedDurationText: resolveNonEmptyString(
        activePlan!.initialEstimatedDurationText ?? latest.estimatedDurationText,
      ),
      kwhPerUnitSource: latest.kwhPerUnitSource,
      tone: resolveHeroTone(latest.planStatus),
      plannedTotalCost: costAndDelivery.plannedTotalCost,
      deliveredCostSoFar: costAndDelivery.deliveredCostSoFar,
      costUnit: input.costDisplay.unit,
      deliveredKWh: costAndDelivery.deliveredKWh,
      plannedTotalKWh: energyNeededKWh,
      currentProgress: progress.currentValue,
      startProgress,
      targetValue: progress.targetValue,
      targetUnit: progress.unit,
    }),
    timeline: buildTimeline({
      device, bootstrap, deviceId, hours,
      originalChargeByStartMs, currentChargeByStartMs,
      latestRevisionReason: latest.reason,
      progressStart: progress.currentValue,
      progressTarget: progress.targetValue,
      progressPerKWh,
      progressUnit: progress.unit,
      deadlineAtMs,
      costDisplay: input.costDisplay,
    }),
    planInputs: buildPlanInputs({
      labels,
      device,
      provenance: activePlan!.kwhPerUnitProvenance,
      objective,
      planningSpeedKw,
      nowMs,
      ...resolveKwhPerUnitDisplayRate({ latest, profile, objectiveKind: objective.kind }),
    }),
  };
};

const buildObjectivePayload = (params: ObjectivePlanInput): ObjectivePayloadResult | null => {
  const prepared = prepareObjectivePayload(params);
  if (prepared === null) return null;
  if ('kind' in prepared) return prepared;
  return { kind: 'ok', payload: buildReadyPayload(prepared) };
};

export type DeadlineRenderInput =
  | { status: 'pending'; pending: DeadlinePlanPendingPayload }
  | { status: 'ready'; payload: DeadlinePlanPayload }
  | { status: 'unavailable'; kind: DeferredObjectiveSettingsEntry['kind']; reason: DeadlinePlanUnavailableReason }
  | { status: 'completed'; kind: DeferredObjectiveSettingsEntry['kind'] }
  | { status: 'absent' };

export const resolveRenderInput = (params: ObjectivePlanInput): DeadlineRenderInput => {
  const ctxResult = resolveObjectiveContext(params);
  if (ctxResult.kind === 'absent') return { status: 'absent' };
  if (ctxResult.kind === 'completed') return { status: 'completed', kind: ctxResult.objectiveKind };
  const ctx = ctxResult.context;
  const priceContext = resolvePendingPriceContext(params.prices);
  // No persisted record yet OR record is explicitly pending → pending hero.
  if (!ctx.activePlan || ctx.activePlan.pending || !ctx.activePlan.latest) {
    return { status: 'pending', pending: buildPendingPayload(ctx, priceContext) };
  }
  const result = buildObjectivePayload(params);
  if (!result) return { status: 'absent' };
  if (result.kind === 'unavailable') {
    return { status: 'unavailable', kind: ctx.objective.kind, reason: result.reason };
  }
  if (result.kind === 'awaiting_prices') {
    return { status: 'pending', pending: buildPendingPayload(ctx, priceContext) };
  }
  return { status: 'ready', payload: result.payload };
};


type HistoryView = Parameters<typeof renderDeadlinePlan>[1] extends { history?: infer H } ? H : never;

export const resolveDeadlinePlanLoadState = (
  renderInput: DeadlineRenderInput,
  history: HistoryView | undefined,
): DeadlinePlanLoadState => {
  if (renderInput.status === 'absent') {
    // Genuinely unknown device or feature gated off — keep the legacy error
    // card. Lifecycle transitions (passed deadline, auto-disable) go through
    // the `completed` branch instead.
    return { status: 'error', message: 'Smart task data is not available for this device.', history };
  }
  if (renderInput.status === 'completed') {
    return { status: 'completed', objectiveKind: renderInput.kind, history };
  }
  if (renderInput.status === 'ready') {
    return { status: 'ready', payload: renderInput.payload, history };
  }
  if (renderInput.status === 'unavailable') {
    return {
      status: 'unavailable',
      objectiveKind: renderInput.kind,
      reason: renderInput.reason,
      history,
    };
  }
  return { status: 'pending', pending: renderInput.pending, history };
};

export const testExports = {
  buildObjectivePayload,
  buildPendingPayload,
  resolveRenderInput,
};
