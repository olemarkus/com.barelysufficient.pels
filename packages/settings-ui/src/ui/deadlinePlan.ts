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
} from '../../../shared-domain/src/deadlineLabels.ts';
import { buildPlanInputs } from './deadlinePlanInputs.ts';
import { buildTrajectory } from './deadlinePlanTrajectory.ts';
import { buildTimeline } from './deadlinePlanTimeline.ts';
import {
  buildHero,
  resolveHeroStatusChip,
  type DeadlineHeroStatusChip,
} from './deadlinePlanHero.ts';
import { formatHourLabel } from './deadlinePlanFormatters.ts';
import { buildChargeByStartMs } from './deadlinePlanHourMaps.ts';
import {
  buildPendingHero,
  resolvePendingPriceContext,
  resolvePendingReason,
} from './deadlinePlanPending.ts';
import { buildRevisionPanelFeed } from './deadlinePlanRevisionPanelFeed.ts';
import { resolveCostDisplayFromCombinedPrices, resolvePriceUnitLabel } from './priceUnit.ts';
import {
  collectHorizonHours,
  type DeadlinePlanSchedule,
  type ObjectivePayloadReady,
  type ResolvedObjectiveContext,
} from './deadlinePlanData.ts';
import { resolveEnergyNeededKWh, resolveTaskProgress } from './deadlinePlanResolvers.ts';
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
  priceContext: Pick<DeadlinePendingContext, 'priceSource' | 'lastFetchedShort' | 'hasCurrentPrice'>,
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
  // cause (the car stopped at its own charge limit, the device stopped taking power): the
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
    // The live cause's short line heads the card and its reason line explains it.
    ...(liveCause === null ? {} : { headline: liveCause.listLine, body: liveCause.reason }),
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
  const progressDirection = ctx.activePlan.progressDirection;
  const directionUnavailable = resolveDirectionUnavailable(ctx.objective.kind, progressDirection);
  if (directionUnavailable !== null) return directionUnavailable;
  const progress = resolveTaskProgress(ctx.device, ctx.objective, ctx.activePlan);
  if (!progress) return resolveNoReadingResult(ctx.objective.kind, ctx.activePlan, ctx.activePlan.latest);
  if (progress.remainingUnits <= 0) {
    return alreadySatisfiedResult(ctx.objective.kind, progressDirection);
  }

  const windowStartMs = Math.min(ctx.nowMs, ctx.activePlan.original?.revisedAtMs ?? ctx.nowMs);
  const hours = collectHorizonHours(ctx.deadlineAtMs, windowStartMs, params.prices);
  if (hours.length === 0) return { kind: 'awaiting_prices' };

  const costDisplay = resolveCostDisplayFromCombinedPrices(params.prices.combinedPrices);
  return {
    ctx,
    bootstrap: params.bootstrap,
    progress,
    hours,
    energy: resolveEnergyNeededKWh(ctx.activePlan),
    costDisplay,
    priceUnitLabel: resolvePriceUnitLabel(costDisplay),
  };
};

const buildReadyPayload = (input: ObjectivePayloadReady): DeadlinePlanPayload => {
  const { ctx, progress } = input;
  const { objective, activePlan } = ctx;
  const latest = activePlan.latest;
  const schedule: DeadlinePlanSchedule = {
    labels: deadlineLabels(objective.kind, progress.progressDirection),
    // The overlay never reaches `latest`: the committed revision stays the
    // trajectory the hero's budget-cause derivation reads, because a device
    // left off is not a budget shortfall.
    planStatus: resolveEffectivePlanStatus(latest.planStatus, activePlan),
    originalChargeByStartMs: buildChargeByStartMs(activePlan.original ?? latest),
    currentChargeByStartMs: buildChargeByStartMs(latest),
  };
  const revisionPanelFeed = buildRevisionPanelFeed({
    latest,
    history: activePlan.history,
    kind: objective.kind,
  });

  return {
    kind: objective.kind,
    labels: schedule.labels,
    priceUnitLabel: input.priceUnitLabel,
    hero: buildHero(input, schedule),
    timeline: buildTimeline(input, schedule),
    trajectory: buildTrajectory(input, schedule),
    planInputs: buildPlanInputs(input, schedule),
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
  const priceContext = resolvePendingPriceContext(params.prices, ctx.nowMs);
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
