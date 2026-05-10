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
import type { DeviceObjectiveProfile } from '../../../contracts/src/objectiveProfileTypes.ts';
import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { deadlineLabels, type DeadlineLabels } from '../../../shared-domain/src/deadlineLabels.ts';
import {
  allocateChargeHours,
  collectHorizonHours,
  isFiniteNumber,
  ONE_HOUR_MS,
  type HorizonHour,
} from './deadlinePlanData.ts';
import {
  renderDeadlinePlan,
  type DeadlinePlanPayload,
} from './views/DeadlinePlan.tsx';
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

const DEADLINE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

const resolveDeadlineAtMs = (deadlineLocalTime: string, nowMs: number): number | null => {
  const match = deadlineLocalTime.match(DEADLINE_TIME_PATTERN);
  if (!match) return null;
  const now = new Date(nowMs);
  const deadline = new Date(now);
  deadline.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (deadline.getTime() <= nowMs) {
    deadline.setDate(deadline.getDate() + 1);
  }
  return deadline.getTime();
};

const resolveUsefulPowerKw = (device: TargetDeviceSnapshot): number | null => {
  const candidates = [
    device.planningPowerKw,
    device.expectedPowerKw,
    device.powerKw,
    device.loadKw,
  ];
  const value = candidates.find((candidate) => isFiniteNumber(candidate) && candidate > 0);
  if (value) return value;
  const steps = device.steppedLoadProfile?.steps ?? [];
  const highestStepPowerW = Math.max(
    0,
    ...steps.map((step) => (
      isFiniteNumber(step.planningPowerW) ? step.planningPowerW : 0
    )),
  );
  return highestStepPowerW > 0 ? highestStepPowerW / 1000 : null;
};

const resolveProfileSampleValue = (
  profile: DeviceObjectiveProfile | null,
  unit: DeviceObjectiveProfile['lastSample']['unit'],
): number | null => {
  if (!profile || profile.lastSample.unit !== unit) return null;
  return isFiniteNumber(profile.lastSample.value) ? profile.lastSample.value : null;
};

const resolveProgress = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  profile: DeviceObjectiveProfile | null;
}): {
  currentValue: number;
  remainingUnits: number;
  targetValue: number;
  unit: '°C' | '%';
} | null => {
  const { device, objective, profile } = params;
  if (objective.kind === 'temperature') {
    const currentTemperature = isFiniteNumber(device.currentTemperature)
      ? device.currentTemperature
      : resolveProfileSampleValue(profile, 'degree_c');
    if (!isFiniteNumber(currentTemperature)) return null;
    const remainingUnits = Math.max(0, objective.targetTemperatureC - currentTemperature);
    return {
      currentValue: currentTemperature,
      remainingUnits,
      targetValue: objective.targetTemperatureC,
      unit: '°C',
    };
  }

  const percent = isFiniteNumber(device.stateOfCharge?.percent)
    ? device.stateOfCharge.percent
    : resolveProfileSampleValue(profile, 'percent');
  if (!isFiniteNumber(percent)) return null;
  return {
    currentValue: Math.min(100, Math.max(0, percent)),
    remainingUnits: Math.max(0, objective.targetPercent - percent),
    targetValue: objective.targetPercent,
    unit: '%',
  };
};

const resolveProfile = (
  powerTracker: PowerTrackerState | null,
  deviceId: string,
  objectiveKind: DeferredObjectiveSettingsEntry['kind'],
): DeviceObjectiveProfile | null => {
  const profile = powerTracker?.objectiveProfiles?.[deviceId];
  return profile?.kind === objectiveKind ? profile : null;
};

const resolveEnergyNeededKWh = (params: {
  profile: DeviceObjectiveProfile | null;
  remainingUnits: number;
}): { energyNeededKWh: number; confidence: string | null } | null => {
  const stat = params.profile?.kwhPerUnit;
  if (!stat || !isFiniteNumber(stat.mean) || stat.mean <= 0) return null;
  return {
    energyNeededKWh: params.remainingUnits * stat.mean,
    confidence: stat.confidence,
  };
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

const buildObjectivePayload = (params: ObjectivePlanInput): DeadlinePlanPayload | null => {
  const nowMs = params.nowMs ?? Date.now();
  const deviceId = params.deviceId?.trim();
  if (!deviceId) return null;
  if (params.bootstrap.featureAccess.canToggleOverviewRedesign !== true) return null;

  const settings = normalizeDeferredObjectiveSettings(params.bootstrap.settings.deferred_objectives);
  const objective = settings.objectivesByDeviceId[deviceId];
  const device = params.devices.find((candidate) => candidate.id === deviceId);
  if (!objective || !objective.enabled || !device) return null;

  const deadlineAtMs = resolveDeadlineAtMs(objective.deadlineLocalTime, nowMs);
  if (deadlineAtMs === null) return null;

  const profile = resolveProfile(params.bootstrap.power.tracker, deviceId, objective.kind);
  const progress = resolveProgress({ device, objective, profile });
  const energy = progress
    ? resolveEnergyNeededKWh({ profile, remainingUnits: progress.remainingUnits })
    : null;
  const usefulPowerKw = resolveUsefulPowerKw(device);
  const hours = collectHorizonHours({
    bootstrap: params.bootstrap,
    deadlineAtMs,
    device,
    nowMs,
    prices: params.prices,
  });
  if (!progress || !energy || !usefulPowerKw || hours.length === 0) return null;

  const chargeByStartMs = allocateChargeHours({
    energyNeededKWh: energy.energyNeededKWh,
    hours,
    nowMs,
    usefulPowerKw,
  });
  const progressPerKWh = energy.energyNeededKWh > 0
    ? progress.remainingUnits / energy.energyNeededKWh
    : 0;
  const labels = deadlineLabels(objective.kind);
  const firstChargingHour = hours.find((hour) => chargeByStartMs.has(hour.startsAtMs));
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
  };
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
    const payload = buildObjectivePayload({ bootstrap, deviceId, devices: devicesPayload.devices, prices });
    renderDeadlinePlan(surface, payload
      ? { status: 'ready', payload, history }
      : { status: 'error', message: 'Deadline plan data is not available for this device.', history });
  } catch {
    renderDeadlinePlan(surface, {
      status: 'error',
      message: 'Deadline plan data is not available for this device.',
    });
  }
};

export const testExports = {
  buildObjectivePayload,
  resolveDeadlineAtMs,
};
