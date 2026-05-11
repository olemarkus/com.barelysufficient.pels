import { callApi } from './homey.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiBootstrap,
  type SettingsUiDevicesPayload,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { fetchDeadlinePlanHistory, resolveBrowserTimeZone } from './deadlinePlanHistoryFetch.ts';
import {
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveSettingsEntry,
} from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import {
  deadlineLabels,
  type DeadlineLabels,
  type DeadlinePlanPendingReason,
  type DeadlinePlanUnavailableReason,
} from '../../../shared-domain/src/deadlineLabels.ts';
import {
  collectHorizonHours,
  ONE_HOUR_MS,
  type HorizonHour,
} from './deadlinePlanData.ts';
import {
  resolveEnergyNeededKWh,
  resolveProfile,
  resolveProgress,
  resolveUsefulPowerKw,
} from './deadlinePlanResolvers.ts';
import {
  renderDeadlinePlan,
  type DeadlinePlanLoadState,
  type DeadlinePlanPayload,
  type DeadlinePlanPendingPayload,
} from './views/DeadlinePlan.tsx';
import type {
  DeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { setStoredOverviewRedesignPreference } from './uiVariant.ts';

export const isDeadlinePlanPage = (): boolean => (
  document.getElementById('deadline-plan-root') !== null
);

const closeDeadlinePlanPage = (): void => {
  if (new URLSearchParams(window.location.search).get('ui') === 'redesign') {
    setStoredOverviewRedesignPreference(true);
  }
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.close();
};

const initDeadlinePlanClose = (): void => {
  document
    .querySelector<HTMLButtonElement>('[data-deadline-plan-close]')
    ?.addEventListener('click', closeDeadlinePlanPage);
};

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
}): DeadlinePlanPayload['hero']['chips'] => {
  const isActiveNow = params.firstChargingHour && params.firstChargingHour.startsAtMs <= params.nowMs;
  return [
    {
      text: isActiveNow ? params.labels.activeChipLabel : params.labels.waitingChipLabel,
      tone: 'ok',
    },
    { text: params.labels.kindChipLabel, tone: 'info' },
    ...(params.confidence ? [{ text: `Confidence ${params.confidence}`, tone: 'muted' as const }] : []),
  ];
};

const resolveHeroHeadline = (params: {
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
}): string => {
  if (!params.firstChargingHour) return 'On track for the deadline';
  if (params.firstChargingHour.startsAtMs <= params.nowMs) return `${params.labels.activeChipLabel} now`;
  return `Waiting until ${formatHourLabel(params.firstChargingHour.startsAtMs)}`;
};

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
}): DeadlinePlanPayload['hero'] => {
  const headline = resolveHeroHeadline(params);
  const target = formatTarget(params.objective);
  const deadline = formatDeadlineFull(params.deadlineAtMs);
  const subline = `${params.device.name} • Target ${target} by ${deadline}`;
  const energy = `${params.energyNeededKWh.toFixed(1)} kWh`;
  const hourWord = params.hoursLeft === 1 ? 'hour' : 'hours';
  const metaLine = `Needs ${energy} • ${params.hoursLeft} ${hourWord} left`;
  return {
    chips: buildHeroChips({
      labels: params.labels,
      firstChargingHour: params.firstChargingHour,
      nowMs: params.nowMs,
      confidence: params.confidence,
    }),
    sectionLabel: `${params.labels.kindChipLabel} plan`,
    headline,
    subline,
    metaLine,
  };
};

const buildTimeline = (params: {
  device: TargetDeviceSnapshot;
  hours: HorizonHour[];
  chargeByStartMs: Map<number, number>;
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
      const chargerKwh = params.chargeByStartMs.get(hour.startsAtMs) ?? 0;
      return chargerKwh > 0
        ? Math.min(params.progressTarget, params.progressStart + chargerKwh * params.progressPerKWh)
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
      const chargerKwh = params.chargeByStartMs.get(hour.startsAtMs) ?? 0;
      if (chargerKwh > 0) {
        projectedProgress = Math.min(params.progressTarget, projectedProgress + chargerKwh * params.progressPerKWh);
      }
      return {
        time: formatHourLabel(hour.startsAtMs),
        price: formatPrice(hour.price),
        priceValue: hour.price,
        tone: resolvePriceTone(hour),
        planned: chargerKwh > 0,
        usage: {
          backgroundKwh: Math.max(0, hour.plannedOtherKWh),
          deviceKwh: chargerKwh,
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

const resolveObjectiveContext = (params: ObjectivePlanInput): ResolvedObjectiveContext | null => {
  const nowMs = params.nowMs ?? Date.now();
  const deviceId = params.deviceId?.trim();
  if (!deviceId) return null;
  if (params.bootstrap.featureAccess.canToggleOverviewRedesign !== true) return null;
  const settings = normalizeDeferredObjectiveSettings(params.bootstrap.settings.deferred_objectives);
  const objective = settings.objectivesByDeviceId[deviceId];
  const device = params.devices.find((candidate) => candidate.id === deviceId);
  if (!objective || !objective.enabled || !device) return null;
  const activePlan = params.bootstrap.deferredObjectiveActivePlans?.plansByDeviceId[deviceId] ?? null;
  const deadlineAtMs = activePlan?.deadlineAtMs ?? objective.deadlineAtMs;
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= nowMs) return null;
  return { device, objective, deviceId, deadlineAtMs, activePlan, nowMs };
};

const resolvePendingReason = (
  activePlan: DeferredObjectiveActivePlanV1 | null,
): DeadlinePlanPendingReason => activePlan?.pendingReason ?? 'awaiting_horizon_plan';

const buildPendingHero = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  labels: DeadlineLabels;
  deadlineAtMs: number;
  pendingReason: DeadlinePlanPendingReason;
}): DeadlinePlanPendingPayload['hero'] => {
  const target = formatTarget(params.objective);
  const deadline = formatDeadlineFull(params.deadlineAtMs);
  const copy = params.labels.pendingHeroByReason[params.pendingReason];
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

const buildPendingPayload = (ctx: ResolvedObjectiveContext): DeadlinePlanPendingPayload => {
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
    }),
  };
};

const buildChargeByStartMsFromActivePlan = (
  activePlan: DeferredObjectiveActivePlanV1,
): Map<number, number> => {
  const out = new Map<number, number>();
  if (!activePlan.latest) return out;
  for (const hour of activePlan.latest.hours) {
    out.set(hour.startsAtMs, hour.plannedKWh);
  }
  return out;
};

type ObjectivePayloadResult =
  | { kind: 'ok'; payload: DeadlinePlanPayload }
  | { kind: 'unavailable'; reason: DeadlinePlanUnavailableReason };

const buildObjectivePayload = (params: ObjectivePlanInput): ObjectivePayloadResult | null => {
  const ctx = resolveObjectiveContext(params);
  if (!ctx) return null;
  const { device, objective, deviceId, deadlineAtMs, activePlan, nowMs } = ctx;
  // Without a persisted plan with an allocation we cannot render the timeline
  // — runtime is the source of truth. Caller will fall back to the pending
  // state when this returns null.
  if (!activePlan || !activePlan.latest) return null;

  const profile = resolveProfile(params.bootstrap.power.tracker, deviceId, objective.kind);
  const progress = resolveProgress({ device, objective, profile });
  if (!progress) return { kind: 'unavailable', reason: 'no_current_reading' };
  // Current value already meets or exceeds the target. The recorder may have written a
  // revision with all-zero `plannedKWh` hours; reporting "no energy estimate" here would
  // misdiagnose a satisfied deadline as a profile-learning problem.
  if (progress.remainingUnits <= 0) return { kind: 'unavailable', reason: 'already_satisfied' };
  const usefulPowerKw = resolveUsefulPowerKw(device);
  if (!usefulPowerKw) return { kind: 'unavailable', reason: 'no_useful_power' };
  const energy = resolveEnergyNeededKWh({ profile, remainingUnits: progress.remainingUnits, activePlan });
  if (!energy) return { kind: 'unavailable', reason: 'no_energy_estimate' };
  // For an active plan, include past hours from the first revision's start so
  // the chart can show history. Without a revision, fall back to nowMs.
  const windowStartMs = Math.min(nowMs, activePlan.original?.revisedAtMs ?? nowMs);
  const hours = collectHorizonHours({
    bootstrap: params.bootstrap,
    deadlineAtMs,
    device,
    windowStartMs,
    prices: params.prices,
  });
  if (hours.length === 0) return { kind: 'unavailable', reason: 'no_horizon_hours' };

  const chargeByStartMs = buildChargeByStartMsFromActivePlan(activePlan);
  const progressPerKWh = energy.energyNeededKWh > 0
    ? progress.remainingUnits / energy.energyNeededKWh
    : 0;
  const labels = deadlineLabels(objective.kind);
  const firstChargingHour = hours.find((hour) => chargeByStartMs.has(hour.startsAtMs));
  const hoursLeft = Math.max(0, Math.ceil((deadlineAtMs - nowMs) / ONE_HOUR_MS));

  return {
    kind: 'ok',
    payload: {
      kind: objective.kind,
      labels,
      hero: buildHero({
        device,
        objective,
        labels,
        firstChargingHour,
        deadlineAtMs,
        energyNeededKWh: energy.energyNeededKWh,
        hoursLeft,
        confidence: energy.confidence,
        nowMs,
      }),
      timeline: buildTimeline({
        device,
        hours,
        chargeByStartMs,
        progressStart: progress.currentValue,
        progressTarget: progress.targetValue,
        progressPerKWh,
        progressUnit: progress.unit,
        deadlineAtMs,
      }),
    },
  };
};

export const resolveRenderInput = (
  params: ObjectivePlanInput,
): { status: 'pending'; pending: DeadlinePlanPendingPayload }
  | { status: 'ready'; payload: DeadlinePlanPayload }
  | { status: 'unavailable'; kind: DeferredObjectiveSettingsEntry['kind']; reason: DeadlinePlanUnavailableReason }
  | null => {
  const ctx = resolveObjectiveContext(params);
  if (!ctx) return null;
  // No persisted record yet OR record is explicitly pending → pending hero.
  if (!ctx.activePlan || ctx.activePlan.pending || !ctx.activePlan.latest) {
    return { status: 'pending', pending: buildPendingPayload(ctx) };
  }
  const result = buildObjectivePayload(params);
  if (!result) return null;
  if (result.kind === 'unavailable') {
    return { status: 'unavailable', kind: ctx.objective.kind, reason: result.reason };
  }
  return { status: 'ready', payload: result.payload };
};

type RenderInput = ReturnType<typeof resolveRenderInput>;
type HistoryView = Parameters<typeof renderDeadlinePlan>[1] extends { history?: infer H } ? H : never;

const resolveDeadlinePlanLoadState = (
  renderInput: RenderInput,
  history: HistoryView | undefined,
): DeadlinePlanLoadState => {
  if (renderInput === null) {
    return { status: 'error', message: 'Deadline plan data is not available for this device.', history };
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

export const mountDeadlinePlan = async (): Promise<void> => {
  const surface = document.getElementById('deadline-plan-root');
  if (!surface) return;

  const deviceId = new URLSearchParams(window.location.search).get('deviceId');
  const timeZone = resolveBrowserTimeZone();

  initDeadlinePlanClose();
  renderDeadlinePlan(surface, { status: 'loading' });
  try {
    const [bootstrap, devicesPayload, history] = await Promise.all([
      callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH),
      callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH),
      fetchDeadlinePlanHistory(deviceId, timeZone),
    ]);
    let prices = bootstrap.prices;
    try {
      prices = await callApi<SettingsUiPricesPayload>('GET', SETTINGS_UI_PRICES_PATH);
    } catch {
      prices = bootstrap.prices;
    }
    const renderInput = resolveRenderInput({ bootstrap, deviceId, devices: devicesPayload.devices, prices });
    renderDeadlinePlan(surface, resolveDeadlinePlanLoadState(renderInput, history));
  } catch {
    renderDeadlinePlan(surface, {
      status: 'error',
      message: 'Deadline plan data is not available for this device.',
    });
  }
};

export const testExports = {
  buildObjectivePayload,
  buildPendingPayload,
  resolveRenderInput,
};
