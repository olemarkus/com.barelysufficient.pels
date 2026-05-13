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
  type DeadlineLabels,
  type DeadlinePendingContext,
  type DeadlinePendingPriceSource,
  type DeadlinePlanPendingReason,
  type DeadlinePlanUnavailableReason,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { buildPlanInputs } from './deadlinePlanInputs.ts';
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
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';

type ObjectivePlanInput = {
  bootstrap: SettingsUiBootstrap;
  deviceId: string | null;
  devices: TargetDeviceSnapshot[];
  prices: SettingsUiPricesPayload;
  nowMs?: number;
};

const formatHourLabel = (startsAtMs: number): string => (
  new Date(startsAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
);

const formatPrice = (total: number): string => total.toFixed(2);

const formatDeadlineFull = (deadlineAtMs: number): string => (
  new Date(deadlineAtMs).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
);

const formatDeadlineShort = (deadlineAtMs: number): string => (
  new Date(deadlineAtMs).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  })
);

const formatTemperature = (value: number): string => (
  Number.isInteger(value) ? `${value} °C` : `${value.toFixed(1)} °C`
);

const formatTarget = (objective: DeferredObjectiveSettingsEntry): string => (
  objective.kind === 'temperature'
    ? formatTemperature(objective.targetTemperatureC)
    : `${objective.targetPercent}%`
);

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

const buildHeroChips = (params: {
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
  confidence: string | null;
  cannotMeet: boolean;
}): DeadlinePlanPayload['hero']['chips'] => {
  const isActiveNow = params.firstChargingHour && params.firstChargingHour.startsAtMs <= params.nowMs;
  return [
    {
      text: isActiveNow ? params.labels.activeChipLabel : params.labels.waitingChipLabel,
      tone: 'ok',
    },
    { text: params.labels.kindChipLabel, tone: 'info' },
    ...(params.cannotMeet ? [{ text: params.labels.cannotMeetChipLabel, tone: 'warn' as const }] : []),
    ...(params.confidence ? [{ text: `Confidence ${params.confidence}`, tone: 'muted' as const }] : []),
  ];
};

const resolveHeroHeadline = (params: {
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
  cannotMeet: boolean;
}): string => {
  if (params.cannotMeet) return params.labels.cannotMeetChipLabel;
  if (!params.firstChargingHour) return 'On track';
  if (params.firstChargingHour.startsAtMs <= params.nowMs) return `${params.labels.activeChipLabel} now`;
  return `Waiting until ${formatHourLabel(params.firstChargingHour.startsAtMs)}`;
};

const formatShortfallLabel = (shortfallUnits: number, unit: '°C' | '%'): string => (
  // For `%` clamp to ≥ 1 with `ceil` so a sub-1% shortfall does not render as
  // "0%" while the warning chip says "Cannot finish" — that mismatch was
  // flagged on the original PR (copilot review of `formatShortfallLabel`).
  unit === '°C' ? `${shortfallUnits.toFixed(1)} °C` : `${Math.max(1, Math.ceil(shortfallUnits))}%`
);

const buildHero = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  deadlineAtMs: number;
  energyNeededKWh: number;
  hoursLeft: number;
  confidence: string | null;
  nowMs: number;
  cannotMeet: boolean;
  shortfallUnits: number;
  shortfallUnit: '°C' | '%';
}): DeadlinePlanPayload['hero'] => {
  const headline = resolveHeroHeadline(params);
  const target = formatTarget(params.objective);
  const deadline = formatDeadlineFull(params.deadlineAtMs);
  const subline = `${params.device.name} • Target ${target} by ${deadline}`;
  const energy = `${params.energyNeededKWh.toFixed(1)} kWh`;
  const hourWord = params.hoursLeft === 1 ? 'hour' : 'hours';
  // When the chip says "Cannot finish" we must not fall back to the
  // on-track "Needs X kWh • Y hours left" copy — that contradicts the chip.
  // A zero shortfall under cannot_meet means rounding has flattened the gap;
  // surface a softer body line instead so the two pieces stay consistent.
  const cannotMeetMeta = params.shortfallUnits > 0
    ? params.labels.cannotMeetShortfall(formatShortfallLabel(params.shortfallUnits, params.shortfallUnit))
    : params.labels.cannotMeetFallback;
  const metaLine = params.cannotMeet
    ? cannotMeetMeta
    : `Needs ${energy} • ${params.hoursLeft} ${hourWord} left`;
  return {
    chips: buildHeroChips({
      labels: params.labels,
      firstChargingHour: params.firstChargingHour,
      nowMs: params.nowMs,
      confidence: params.confidence,
      cannotMeet: params.cannotMeet,
    }),
    sectionLabel: `${params.labels.kindChipLabel} plan`,
    headline,
    subline,
    metaLine,
  };
};

const buildTimeline = (params: {
  device: TargetDeviceSnapshot;
  bootstrap: SettingsUiBootstrap;
  deviceId: string;
  hours: HorizonHour[];
  originalChargeByStartMs: Map<number, number>;
  currentChargeByStartMs: Map<number, number>;
  progressStart: number;
  progressTarget: number;
  progressPerKWh: number;
  progressUnit: '°C' | '%';
  deadlineAtMs: number;
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
    ariaLabel: `Deadline plan for ${params.device.name}`,
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
      return {
        time: formatHourLabel(hour.startsAtMs),
        price: formatPrice(hour.price),
        priceValue: hour.price,
        tone: resolvePriceTone(hour),
        planned: currentKwh > 0,
        changed: Math.abs(originalKwh - currentKwh) > 0.001,
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
// or unrecognised so the copy falls back to neutral wording.
const resolvePendingContext = (prices: SettingsUiPricesPayload): DeadlinePendingContext => {
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
  return {
    chips: [
      { text: params.labels.waitingChipLabel, tone: 'info' },
      { text: params.labels.kindChipLabel, tone: 'info' },
    ],
    sectionLabel: `${params.labels.kindChipLabel} plan`,
    headline: copy.headline,
    subline: `${params.device.name} • Target ${target} by ${deadline}`,
    metaLine: copy.body,
  };
};

const buildPendingPayload = (
  ctx: ResolvedObjectiveContext,
  pendingContext: DeadlinePendingContext,
): DeadlinePlanPendingPayload => {
  const labels = deadlineLabels(ctx.objective.kind);
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

const resolveShortfall = (params: {
  progress: ReturnType<typeof resolveProgress>;
  allocatedKWh: number;
  progressPerKWh: number;
}): { cannotMeetUnits: number } => {
  if (!params.progress) return { cannotMeetUnits: 0 };
  const projected = Math.min(
    params.progress.targetValue,
    params.progress.currentValue + params.allocatedKWh * params.progressPerKWh,
  );
  return { cannotMeetUnits: Math.max(0, params.progress.targetValue - projected) };
};

type ObjectivePayloadReady = {
  ctx: ResolvedObjectiveContext;
  bootstrap: SettingsUiBootstrap;
  profile: ReturnType<typeof resolveProfile>;
  progress: NonNullable<ReturnType<typeof resolveProgress>>;
  hours: HorizonHour[];
  energy: ReturnType<typeof resolveEnergyNeededKWh>;
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

  return {
    ctx,
    bootstrap: params.bootstrap,
    profile,
    progress,
    hours,
    energy: resolveEnergyNeededKWh({ profile, activePlan: ctx.activePlan }),
  };
};

const buildReadyPayload = (input: ObjectivePayloadReady): DeadlinePlanPayload => {
  const { ctx, bootstrap, profile, progress, hours, energy } = input;
  const { device, objective, deviceId, deadlineAtMs, activePlan, nowMs } = ctx;
  const latest = activePlan!.latest!;
  const labels = deadlineLabels(objective.kind);
  const energyNeededKWh = energy?.energyNeededKWh ?? 0;
  const originalChargeByStartMs = buildChargeByStartMs(activePlan!.original ?? latest);
  const currentChargeByStartMs = buildChargeByStartMs(latest);
  const progressPerKWh = energyNeededKWh > 0 ? progress.remainingUnits / energyNeededKWh : 0;
  const allocatedKWh = [...currentChargeByStartMs.values()].reduce((sum, kwh) => sum + Math.max(0, kwh), 0);
  const cannotMeet = latest.planStatus === 'cannot_meet' || latest.planStatus === 'at_risk';
  const { cannotMeetUnits } = resolveShortfall({ progress, allocatedKWh, progressPerKWh });
  const firstChargingHour = hours.find((hour) => currentChargeByStartMs.has(hour.startsAtMs));
  const hoursLeft = Math.max(0, Math.ceil((deadlineAtMs - nowMs) / ONE_HOUR_MS));

  return {
    kind: objective.kind,
    labels,
    hero: buildHero({
      device,
      objective,
      labels,
      firstChargingHour,
      deadlineAtMs,
      energyNeededKWh,
      hoursLeft,
      confidence: energy?.confidence ?? null,
      nowMs,
      cannotMeet,
      shortfallUnits: cannotMeetUnits,
      shortfallUnit: progress.unit,
    }),
    timeline: buildTimeline({
      device,
      bootstrap,
      deviceId,
      hours,
      originalChargeByStartMs,
      currentChargeByStartMs,
      progressStart: progress.currentValue,
      progressTarget: progress.targetValue,
      progressPerKWh,
      progressUnit: progress.unit,
      deadlineAtMs,
    }),
    planInputs: buildPlanInputs({ latest, profile, labels, objectiveKind: objective.kind, device }),
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
  const pendingContext = resolvePendingContext(params.prices);
  // No persisted record yet OR record is explicitly pending → pending hero.
  if (!ctx.activePlan || ctx.activePlan.pending || !ctx.activePlan.latest) {
    return { status: 'pending', pending: buildPendingPayload(ctx, pendingContext) };
  }
  const result = buildObjectivePayload(params);
  if (!result) return { status: 'absent' };
  if (result.kind === 'unavailable') {
    return { status: 'unavailable', kind: ctx.objective.kind, reason: result.reason };
  }
  if (result.kind === 'awaiting_prices') {
    return { status: 'pending', pending: buildPendingPayload(ctx, pendingContext) };
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
    return { status: 'error', message: 'Smart task plan data is not available for this device.', history };
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
