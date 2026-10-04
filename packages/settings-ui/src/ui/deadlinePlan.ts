import type {
  SettingsUiBootstrap,
  SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { normalizeDeferredObjectiveSettings } from '../../../shared-domain/src/settings/deferredObjectiveSettings.ts';
import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { ObservedDeviceState } from '../../../contracts/src/types.ts';
import {
  deadlineLabels,
  isDeviceExclusionPaused,
  resolveEffectivePlanStatus,
  resolveReportedCarChargeLimit,
  resolveSmartTaskBudgetRole,
  resolveSmartTaskLiveCause,
  SMART_TASK_BANNER_UNAVAILABLE_FOR_DEVICE,
  type DeadlinePendingContext,
  type DeadlinePlanPendingReason,
  type DeadlinePlanUnavailableReason,
  type SmartTaskLiveCause,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { buildPlanInputs } from './deadlinePlanInputs.ts';
import { buildTrajectory } from './deadlinePlanTrajectory.ts';
import { buildTimeline, resolveActualDeviceKwh } from './deadlinePlanTimeline.ts';
import {
  buildHero,
  resolveDeadlineHeroTone,
  resolveHeroStatusChip,
  type DeadlineHeroStatusChip,
} from './deadlinePlanHero.ts';
import { formatHourLabel } from './deadlinePlanFormatters.ts';
import { buildChargeByStartMs, buildCoverStartByStartMs } from './deadlinePlanHourMaps.ts';
import {
  buildPendingHero,
  resolvePendingPriceContext,
  resolvePendingReason,
} from './deadlinePlanPending.ts';
import { buildRevisionPanelFeed } from './deadlinePlanRevisionPanelFeed.ts';
import { resolveCostDisplayFromCombinedPrices, resolvePriceUnitLabel } from './priceUnit.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import {
  collectHorizonHours,
  ONE_HOUR_MS,
  type HorizonHour,
} from './deadlinePlanData.ts';
import {
  resolveDisplayRateAndSpeedMode,
  resolveEnergyNeededKWh,
  resolveProfile,
  resolveTaskProgress,
} from './deadlinePlanResolvers.ts';
import {
  renderDeadlinePlan,
  type DeadlinePlanLoadState,
  type DeadlinePlanPayload,
  type DeadlinePlanPendingPayload,
} from './views/DeadlinePlan.tsx';
import type {
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';

type ObjectivePlanInput = {
  bootstrap: SettingsUiBootstrap;
  deviceId: string | null;
  devices: ObservedDeviceState[];
  prices: SettingsUiPricesPayload;
  nowMs?: number;
};

type ResolvedObjectiveContext = {
  device: ObservedDeviceState;
  objective: DeferredObjectiveSettingsEntry;
  deviceId: string;
  deadlineAtMs: number;
  activePlan: ResolvedDeferredObjectiveActivePlanV1 | null;
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

// `reasonOverride` names the page's current blocker when the committed record
// retains an older reason: missing prices or a session that ended after planning.
const buildPendingPayload = (
  ctx: ResolvedObjectiveContext,
  priceContext: Pick<DeadlinePendingContext, 'priceSource' | 'lastFetchedShort'>,
  reasonOverride?: DeadlinePlanPendingReason,
): DeadlinePlanPendingPayload => {
  const labels = deadlineLabels(ctx.objective.kind, ctx.activePlan?.progressDirection ?? 'unknown');
  const reason = reasonOverride ?? resolvePendingReason(ctx.activePlan);
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
    actionMode: reason === 'device_in_sub_home' ? 'clear_only' : 'edit_and_clear',
    labels,
    hero: buildPendingHero({
      device: ctx.device,
      objective: ctx.objective,
      labels,
      deadlineAtMs: ctx.deadlineAtMs,
      pendingReason: reason,
      pendingContext,
    }),
  };
};

type ObjectivePayloadResult =
  // `headline` and `body` replace the reason's fixed copy with the task's live
  // cause (the car stopped at its own charge limit, the device left off): the
  // fixed "Waiting for the first … reading" would contradict a cause the card
  // already names. `statusChip` carries the shared effective status when it is
  // at risk or cannot finish, so a task the list reports At risk is not a
  // neutral waiting card here.
  | {
    kind: 'unavailable';
    reason: DeadlinePlanUnavailableReason;
    headline?: string;
    body?: string;
    statusChip?: DeadlineHeroStatusChip;
  }
  // Active plan exists but the UI lacks prices to render a timeline. The
  // caller routes this to the pending hero so the user sees the same "waiting
  // for prices" copy regardless of whether the recorder or the prices fetch
  // is behind.
  | { kind: 'awaiting_prices' };

type ObjectivePayloadReady = {
  ctx: ResolvedObjectiveContext & {
    activePlan: ResolvedDeferredObjectiveActivePlanV1 & {
      latest: NonNullable<ResolvedDeferredObjectiveActivePlanV1['latest']>;
    };
  };
  bootstrap: SettingsUiBootstrap;
  profile: ReturnType<typeof resolveProfile>;
  progress: NonNullable<ReturnType<typeof resolveTaskProgress>>;
  hours: HorizonHour[];
  energy: ReturnType<typeof resolveEnergyNeededKWh>;
  costDisplay: CostDisplay;
  priceUnitLabel: string;
};

const alreadySatisfiedResult = (
  objectiveKind: DeferredObjectiveSettingsEntry['kind'],
  progressDirection: 'increasing' | 'decreasing' | 'unknown',
): ObjectivePayloadResult => ({
  kind: 'unavailable', reason: 'already_satisfied',
  body: deadlineLabels(objectiveKind, progressDirection).unavailableByReason.already_satisfied.body,
});

const resolveDirectionUnavailable = (
  objectiveKind: DeferredObjectiveSettingsEntry['kind'],
  progressDirection: 'increasing' | 'decreasing' | 'unknown',
): ObjectivePayloadResult | null => {
  if (objectiveKind !== 'temperature' || progressDirection !== 'unknown') return null;
  return { kind: 'unavailable', reason: 'direction_unavailable' };
};


// The live cause's short line heads the card and its reason line explains it.
// Where the reason only restates the short line ("Device is staying off until
// turned on again."), the reason's fixed body stays instead of repeating it.
const resolveNoReadingCauseCopy = (liveCause: SmartTaskLiveCause): { headline: string; body?: string } => (
  liveCause.reason === `${liveCause.listLine}.`
    ? { headline: liveCause.listLine }
    : { headline: liveCause.listLine, body: liveCause.reason }
);

// No current reading (a charger that ended the session at the car's limit takes
// the car's level with it): progress-dependent content, the trajectory and the
// delivered-so-far line, has nothing to stand on. The task's status does not
// depend on it, so the shared effective status and live cause still apply.
const resolveNoReadingResult = (
  objectiveKind: DeferredObjectiveSettingsEntry['kind'],
  activePlan: ResolvedDeferredObjectiveActivePlanV1,
  latest: NonNullable<ResolvedDeferredObjectiveActivePlanV1['latest']>,
): ObjectivePayloadResult => {
  const liveCause = resolveSmartTaskLiveCause(
    activePlan.diagnosticReasonCode, resolveReportedCarChargeLimit(activePlan), resolveSmartTaskBudgetRole(latest),
  );
  const statusChip = resolveHeroStatusChip({
    labels: deadlineLabels(objectiveKind, activePlan.progressDirection),
    planStatus: resolveEffectivePlanStatus(latest.planStatus, activePlan),
  });
  return {
    kind: 'unavailable',
    reason: 'no_current_reading',
    ...(liveCause === null ? {} : resolveNoReadingCauseCopy(liveCause)),
    ...(statusChip === null ? {} : { statusChip }),
  };
};

const hasActivePlanRevision = (
  ctx: ResolvedObjectiveContext,
): ctx is ObjectivePayloadReady['ctx'] => Boolean(ctx.activePlan?.latest);

const prepareObjectivePayload = (
  ctx: ObjectivePayloadReady['ctx'],
  params: ObjectivePlanInput,
): ObjectivePayloadReady | ObjectivePayloadResult => {
  const profile = resolveProfile(params.bootstrap.power.tracker, ctx.deviceId);
  const progressDirection = ctx.activePlan.progressDirection;
  const directionUnavailable = resolveDirectionUnavailable(ctx.objective.kind, progressDirection);
  if (directionUnavailable !== null) return directionUnavailable;
  const progress = resolveTaskProgress(ctx.device, ctx.objective, ctx.activePlan);
  if (!progress) return resolveNoReadingResult(ctx.objective.kind, ctx.activePlan, ctx.activePlan.latest);
  if (progress.remainingUnits <= 0) {
    return alreadySatisfiedResult(ctx.objective.kind, progressDirection);
  }

  const windowStartMs = Math.min(ctx.nowMs, ctx.activePlan.original?.revisedAtMs ?? ctx.nowMs);
  const hours = collectHorizonHours({
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
  deliveredKWh: number;
} => {
  const divisor = Math.max(1, params.costDisplay.divisor);
  let plannedTotalCost = 0;
  let deliveredKWh = 0;
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
    if (proratedKWh > 0) deliveredKWh += proratedKWh;
  }
  return { plannedTotalCost, deliveredKWh };
};

// Producer-side price comparison feeding the queued hero's "Cheaper than now"
// reason line: true iff the planned hours' average price is strictly below
// the current hour's price. Reads the same per-hour prices and planned-hour
// set `buildTimeline` / `resolveLiveCostAndDelivery` consume, so the sentence
// can never contradict the schedule chart rendered beneath it. Raw `hour.price`
// values are compared directly — the CostDisplay divisor scales every hour by
// the same factor, so it cancels out of the comparison. False when the
// comparison can't be made (no planned hours, or no hour contains `nowMs`),
// in which case the resolver falls back to the non-comparative phrasing.
const resolvePlannedWindowCheaperThanNow = (params: {
  hours: HorizonHour[];
  currentChargeByStartMs: Map<number, number>;
  nowMs: number;
}): boolean => {
  // Compares on the PLANNING price (`budgetPrice ?? total`) so the "cheaper than
  // now" claim reconciles with the schedule chart the user sees below it (also
  // planning-priced) and with the hours the scheduler actually ranked. Equals
  // the import-price comparison for a non-prosumer. The divisor cancels out of
  // a relative comparison, so raw planning prices are compared directly.
  const plannedPrices = params.hours
    .filter((hour) => (params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0) > 0)
    .map((hour) => hour.planningPrice);
  if (plannedPrices.length === 0) return false;
  const currentHour = params.hours.find((hour) => (
    params.nowMs >= hour.startsAtMs && params.nowMs < hour.endMs
  ));
  if (!currentHour) return false;
  const plannedAverage = plannedPrices.reduce((sum, price) => sum + price, 0) / plannedPrices.length;
  return plannedAverage < currentHour.planningPrice;
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
  const latest = activePlan.latest;
  const labels = deadlineLabels(objective.kind, progress.progressDirection);
  const energyNeededKWh = energy?.energyNeededKWh ?? 0;
  const heroEnergy = resolveHeroEnergyFields(energy, energyNeededKWh);
  const originalChargeByStartMs = buildChargeByStartMs(activePlan.original ?? latest);
  const currentChargeByStartMs = buildChargeByStartMs(latest);
  const progressPerKWh = energyNeededKWh > 0 ? progress.remainingUnits / energyNeededKWh : 0;
  // The status this page REPORTS: the committed verdict, overlaid with the live
  // per-cycle causes (including a car stopped at its own charge limit). Without
  // the overlay a row the list marks `At risk` opens on a green on-track hero
  // until the next settle. `latest.planStatus` stays the committed trajectory
  // and is still what the budget-cause derivation below reads — a device left
  // off is not a budget shortfall.
  const reportedPlanStatus = resolveEffectivePlanStatus(latest.planStatus, activePlan);
  const carChargeLimit = resolveReportedCarChargeLimit(activePlan);
  // The cannot-meet body copy + recourse fire on a budget-bound verdict. The
  // producer-resolved `latest.floorShortfallCause === 'budget'` is the only
  // signal — it covers the per-bucket background-squeeze case (prod Connected
  // 300) that the retired count-based heuristic missed. Per
  // `feedback_layering_resolution_in_producer` the consumer reads the flat
  // producer field and stops (`resolveSmartTaskBudgetRole`, the rule the list
  // and the widget share). Absence is NOT "unknown": the recorder suppresses
  // the `none` case for byte-stability, so an absent cause means the floor was
  // not short at all.
  // Three states, not a boolean: the budget can explain the shortfall outright
  // (`sole` — lifting the per-bucket cap closes the gap), have a hand in it
  // without closing it (`contributing`), or be uninvolved. The middle one used
  // to be invisible, so a plan whose every hour was budget-shaped read as purely
  // physical. It is resolved before the live cause, which an unreached car
  // limit only supplies when the budget is uninvolved.
  const budgetRole = resolveSmartTaskBudgetRole(latest);
  // The same live cause the Smart tasks widget explains, from the same resolver.
  const liveCause = resolveSmartTaskLiveCause(activePlan.diagnosticReasonCode, carChargeLimit, budgetRole);
  const cannotMeet = reportedPlanStatus === 'cannot_meet' || reportedPlanStatus === 'at_risk';
  const firstChargingHour = hours.find((hour) => currentChargeByStartMs.has(hour.startsAtMs));
  const costAndDelivery = resolveLiveCostAndDelivery({
    bootstrap, deviceId, hours, currentChargeByStartMs, costDisplay: input.costDisplay,
    startedAtMs: activePlan.startedAtMs,
    nowMs,
  });
  const planningSpeedKw = resolvePositiveNumber(activePlan.initialPlanningSpeedKw ?? latest.planningSpeedKw);
  const displayRate = resolveDisplayRateAndSpeedMode({ latest, profile, objectiveKind: objective.kind });

  const revisionPanelFeed = buildRevisionPanelFeed({
    latest,
    history: activePlan.history,
    kind: objective.kind,
  });

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
      confidence: energy?.confidence ?? null,
      learning: heroEnergy.learning,
      planStatus: reportedPlanStatus,
      nowMs,
      cannotMeet,
      budgetRole,
      liveCause,
      carChargeLimit,
      // Latest revision's `computedFromPricesUpTo` is carried verbatim so the
      // hero's headline-reason resolver can branch on "prices not through
      // deadline yet" without re-deriving the comparison at the view layer.
      computedFromPricesUpTo: resolveFiniteNumber(latest.computedFromPricesUpTo),
      // Verified price comparison for the "Cheaper than now" reason line —
      // resolved from the same hour set the timeline + cost sums consume.
      plannedWindowCheaperThanNow: resolvePlannedWindowCheaperThanNow({
        hours, currentChargeByStartMs, nowMs,
      }),
      tone: resolveDeadlineHeroTone(reportedPlanStatus),
      plannedTotalCost: costAndDelivery.plannedTotalCost,
      costUnit: input.costDisplay.unit,
      deliveredKWh: costAndDelivery.deliveredKWh,
      plannedTotalKWh: energyNeededKWh,
      currentProgress: progress.currentValue,
      startProgress: activePlan.startProgressValue ?? null,
      targetValue: progress.targetValue,
      targetUnit: progress.unit,
    }),
    timeline: buildTimeline({
      device, bootstrap, deviceId, hours,
      originalChargeByStartMs, currentChargeByStartMs,
      latestRevisionReason: latest.reason,
      labels,
      deadlineAtMs,
      nowMs,
      costDisplay: input.costDisplay,
      priceUnitLabel: input.priceUnitLabel,
    }),
    trajectory: buildTrajectory({
      device,
      activePlan,
      planStatus: reportedPlanStatus,
      hours,
      currentChargeByStartMs,
      currentCoverStartByStartMs: buildCoverStartByStartMs(latest),
      currentValue: progress.currentValue,
      targetValue: progress.targetValue,
      progressDirection: progress.progressDirection,
      progressPerKWh,
      unit: progress.unit,
      deadlineAtMs,
      nowMs,
      // Same kind verb as the schedule chart's planned band — the two cards'
      // bands speak one word ("Heating" / "Charging").
      runBandLabel: labels.deviceSeriesName,
    }),
    planInputs: buildPlanInputs({
      labels,
      device,
      provenance: activePlan.kwhPerUnitProvenance,
      objective,
      planningSpeedKw,
      nowMs,
      rateMean: displayRate.rateMean,
      usingBootstrap: displayRate.usingBootstrap,
    }),
    // Inline revision-log panel feed. The view's `<RevisionHistoryPanel>`
    // consults `revisionSummary.shouldShowPanel` (producer-resolved) to
    // decide whether to render — true iff at least one revision was *not*
    // a direct user action, so a brand-new task whose only revision is
    // `flow_card` doesn't render a single-row panel that says nothing the
    // user doesn't already know.
    revisionLog: revisionPanelFeed.rows,
    revisionSummary: revisionPanelFeed.summary,
  };
};

export type DeadlineRenderInput =
  | { status: 'pending'; pending: DeadlinePlanPendingPayload }
  | { status: 'ready'; payload: DeadlinePlanPayload }
  | {
    status: 'unavailable';
    kind: DeferredObjectiveSettingsEntry['kind'];
    reason: DeadlinePlanUnavailableReason;
    headline?: string;
    body?: string;
    statusChip?: DeadlineHeroStatusChip;
  }
  | { status: 'completed'; kind: DeferredObjectiveSettingsEntry['kind'] }
  | { status: 'absent' };

export const resolveRenderInput = (params: ObjectivePlanInput): DeadlineRenderInput => {
  const ctxResult = resolveObjectiveContext(params);
  if (ctxResult.kind === 'absent') return { status: 'absent' };
  if (ctxResult.kind === 'completed') return { status: 'completed', kind: ctxResult.objectiveKind };
  const ctx = ctxResult.context;
  const priceContext = resolvePendingPriceContext(params.prices);
  // No persisted record yet, an explicitly pending record, OR a live exclusion
  // blocker (separate meter, device no longer managed) → pending/unavailable
  // hero. The exclusion branch deliberately outranks a committed cached
  // `latest` revision because that schedule stopped governing the moment the
  // device left the planned set.
  if (
    !hasActivePlanRevision(ctx)
      || ctx.activePlan.pending
      || isDeviceExclusionPaused(ctx.activePlan)
  ) {
    return { status: 'pending', pending: buildPendingPayload(ctx, priceContext) };
  }
  // A committed schedule survives unplugging, but cannot describe what runs
  // now. Match the list's pause, except when the car already reached its own
  // lower limit: some chargers end that session with an unplugged reading.
  if (ctx.activePlan.diagnosticReasonCode === 'objective_invalid_session'
    && resolveReportedCarChargeLimit(ctx.activePlan) === null) {
    return { status: 'pending', pending: buildPendingPayload(ctx, priceContext, 'invalid_session') };
  }
  const result = prepareObjectivePayload(ctx, params);
  if ('kind' in result && result.kind === 'unavailable') {
    return {
      status: 'unavailable',
      kind: ctx.objective.kind,
      reason: result.reason,
      ...(result.headline === undefined ? {} : { headline: result.headline }),
      ...(result.body === undefined ? {} : { body: result.body }),
      ...(result.statusChip === undefined ? {} : { statusChip: result.statusChip }),
    };
  }
  if ('kind' in result && result.kind === 'awaiting_prices') {
    return {
      status: 'pending',
      pending: buildPendingPayload(ctx, priceContext, 'awaiting_horizon_plan'),
    };
  }
  return { status: 'ready', payload: buildReadyPayload(result) };
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
    return { status: 'error', message: SMART_TASK_BANNER_UNAVAILABLE_FOR_DEVICE, history };
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
      ...(renderInput.headline === undefined ? {} : { headline: renderInput.headline }),
      ...(renderInput.body === undefined ? {} : { body: renderInput.body }),
      ...(renderInput.statusChip === undefined ? {} : { statusChip: renderInput.statusChip }),
      history,
    };
  }
  return { status: 'pending', pending: renderInput.pending, history };
};
