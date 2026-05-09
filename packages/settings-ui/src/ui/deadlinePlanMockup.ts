import { callApi } from './homey.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiBootstrap,
  type SettingsUiDevicesPayload,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveSettingsEntry,
} from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import type { DeviceObjectiveProfile } from '../../../contracts/src/objectiveProfileTypes.ts';
import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import {
  renderDeadlinePlanMockup,
  type DeadlinePlanMockupPayload,
} from './views/DeadlinePlanMockup.tsx';
import { setStoredOverviewRedesignPreference } from './uiVariant.ts';

export const isDeadlinePlanMockupPage = (): boolean => (
  document.getElementById('deadline-plan-mockup-root') !== null
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

type PriceEntryLike = {
  startsAt: string;
  total: number;
  isCheap?: boolean;
  isExpensive?: boolean;
};

type CombinedPricesLike = {
  prices?: unknown;
};

type HorizonHour = {
  startsAtMs: number;
  endMs: number;
  price: number;
  isCheap?: boolean;
  isExpensive?: boolean;
  plannedOtherKWh: number;
};

type ObjectivePlanInput = {
  bootstrap: SettingsUiBootstrap;
  deviceId: string | null;
  devices: TargetDeviceSnapshot[];
  prices: SettingsUiPricesPayload;
  nowMs?: number;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HARD_CAP_KWH = 10;

const isRecord = (candidate: unknown): candidate is Record<string, unknown> => (
  Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
);

const isFiniteNumber = (candidate: unknown): candidate is number => (
  typeof candidate === 'number' && Number.isFinite(candidate)
);

const getCombinedPrices = (payload: SettingsUiPricesPayload): PriceEntryLike[] => {
  const combined = payload.combinedPrices as CombinedPricesLike | unknown[] | null;
  let entries: unknown[] = [];
  if (Array.isArray(combined)) {
    entries = combined;
  } else if (Array.isArray((combined as CombinedPricesLike | null)?.prices)) {
    entries = (combined as CombinedPricesLike).prices as unknown[];
  }
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.startsAt !== 'string') return [];
    let total: number | null = null;
    if (isFiniteNumber(entry.total)) total = entry.total;
    else if (isFiniteNumber(entry.totalPrice)) total = entry.totalPrice;
    if (!isFiniteNumber(total)) return [];
    return [{
      startsAt: entry.startsAt,
      total,
      ...(entry.isCheap === true ? { isCheap: true } : {}),
      ...(entry.isExpensive === true ? { isExpensive: true } : {}),
    }];
  });
};

const formatHour = (startsAtMs: number): string => (
  new Date(startsAtMs).toLocaleTimeString([], { hour: '2-digit', hour12: false })
);

const formatPrice = (total: number): string => total.toFixed(2);

const formatDeadline = (deadlineAtMs: number): string => (
  new Date(deadlineAtMs).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
);

const formatTarget = (objective: DeferredObjectiveSettingsEntry): string => (
  objective.kind === 'temperature'
    ? `${objective.targetTemperatureC.toFixed(1)} °C`
    : `${objective.targetPercent}%`
);

const resolveDeadlineAtMs = (deadlineLocalTime: string, nowMs: number): number | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(deadlineLocalTime);
  if (!match) return null;
  const now = new Date(nowMs);
  const deadline = new Date(now);
  deadline.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (deadline.getTime() <= nowMs) {
    deadline.setDate(deadline.getDate() + 1);
  }
  return deadline.getTime();
};

const resolveHardCapKWh = (bootstrap: SettingsUiBootstrap): number => {
  const setting = bootstrap.settings.capacity_limit_kw;
  return isFiniteNumber(setting) && setting > 0 ? setting : DEFAULT_HARD_CAP_KWH;
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
  unit: '%' | '°C';
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

const getDailyBudgetDayByBucket = (
  dailyBudget: DailyBudgetUiPayload | null,
  startMs: number,
): { day: DailyBudgetDayPayload; index: number } | null => {
  if (!dailyBudget) return null;
  for (const day of Object.values(dailyBudget.days)) {
    const index = day.buckets.startUtc.findIndex((startUtc) => new Date(startUtc).getTime() === startMs);
    if (index >= 0) return { day, index };
  }
  return null;
};

const resolvePlannedOtherKWh = (
  dailyBudget: DailyBudgetUiPayload | null,
  startMs: number,
  device: TargetDeviceSnapshot,
): number => {
  const match = getDailyBudgetDayByBucket(dailyBudget, startMs);
  if (!match) return 0;
  const uncontrolled = match.day.buckets.plannedUncontrolledKWh?.[match.index];
  const controlled = match.day.buckets.plannedControlledKWh?.[match.index];
  const fallback = match.day.buckets.plannedKWh[match.index];
  if (device.priority === 1 && isFiniteNumber(uncontrolled)) {
    return Math.max(0, uncontrolled);
  }
  const planned = (
    (isFiniteNumber(uncontrolled) ? uncontrolled : 0)
    + (isFiniteNumber(controlled) ? controlled : 0)
  );
  if (planned > 0) return planned;
  return isFiniteNumber(fallback) ? fallback : 0;
};

const collectHorizonHours = (params: {
  bootstrap: SettingsUiBootstrap;
  deadlineAtMs: number;
  device: TargetDeviceSnapshot;
  nowMs: number;
  prices: SettingsUiPricesPayload;
}): HorizonHour[] => (
  getCombinedPrices(params.prices)
    .map((price) => {
      const startsAtMs = new Date(price.startsAt).getTime();
      return {
        price,
        startsAtMs,
      };
    })
    .filter(({ startsAtMs }) => Number.isFinite(startsAtMs))
    .map(({ price, startsAtMs }) => ({
      startsAtMs,
      endMs: startsAtMs + ONE_HOUR_MS,
      price: price.total,
      isCheap: price.isCheap,
      isExpensive: price.isExpensive,
      plannedOtherKWh: resolvePlannedOtherKWh(params.bootstrap.dailyBudget, startsAtMs, params.device),
    }))
    .filter((hour) => hour.endMs > params.nowMs && hour.startsAtMs < params.deadlineAtMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
);

const allocateChargeHours = (params: {
  energyNeededKWh: number;
  hours: HorizonHour[];
  nowMs: number;
  usefulPowerKw: number;
}): Map<number, number> => {
  let remainingKWh = Math.max(0, params.energyNeededKWh);
  const allocation = new Map<number, number>();
  const candidates = params.hours
    .map((hour) => {
      const durationHours = Math.max(0, (hour.endMs - Math.max(hour.startsAtMs, params.nowMs)) / ONE_HOUR_MS);
      return {
        hour,
        capacityKWh: durationHours * params.usefulPowerKw,
      };
    })
    .filter((candidate) => candidate.capacityKWh > 0)
    .sort((left, right) => left.hour.price - right.hour.price || left.hour.startsAtMs - right.hour.startsAtMs);

  for (const candidate of candidates) {
    if (remainingKWh <= 0.001) break;
    const allocated = Math.min(remainingKWh, candidate.capacityKWh);
    allocation.set(candidate.hour.startsAtMs, allocated);
    remainingKWh -= allocated;
  }
  return allocation;
};

const resolvePriceTone = (hour: HorizonHour): DeadlinePlanMockupPayload['timeline']['hours'][number]['tone'] => {
  if (hour.isCheap === true) return 'cheap';
  if (hour.isExpensive === true) return 'expensive';
  return 'normal';
};

const buildHeroChips = (params: {
  objective: DeferredObjectiveSettingsEntry;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
  confidence: string | null;
}): DeadlinePlanMockupPayload['hero']['chips'] => [
  {
    text: params.firstChargingHour && params.firstChargingHour.startsAtMs <= params.nowMs ? 'Charging' : 'Waiting',
    tone: 'ok',
  },
  { text: params.objective.kind === 'temperature' ? 'Temperature' : 'EV', tone: 'info' },
  ...(params.confidence ? [{ text: `Confidence ${params.confidence}`, tone: 'muted' as const }] : []),
];

const buildHero = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  firstChargingHour: HorizonHour | undefined;
  deadlineAtMs: number;
  energyNeededKWh: number;
  usefulPowerKw: number;
  hoursLeft: number;
  confidence: string | null;
  nowMs: number;
}): DeadlinePlanMockupPayload['hero'] => {
  const targetText = formatTarget(params.objective);
  const needsText = `${params.energyNeededKWh.toFixed(1)} kWh`;
  const rateText = `${params.usefulPowerKw.toFixed(1)} kW`;
  return {
    chips: buildHeroChips({
      objective: params.objective,
      firstChargingHour: params.firstChargingHour,
      nowMs: params.nowMs,
      confidence: params.confidence,
    }),
    sectionLabel: `${params.device.name}`,
    headline: `Target ${targetText} by ${formatDeadline(params.deadlineAtMs)}`,
    subline: `Needs ${needsText} · expected ${rateText} · ${params.hoursLeft} hours left`,
    decision: params.firstChargingHour
      ? `Waiting by plan — first planned hour starts at ${formatHour(params.firstChargingHour.startsAtMs)}.`
      : 'Target is already expected to be met.',
  };
};

const buildTimeline = (params: {
  device: TargetDeviceSnapshot;
  hours: HorizonHour[];
  chargeByStartMs: Map<number, number>;
  hardCapKWh: number;
  progressStart: number;
  progressTarget: number;
  progressPerKWh: number;
  progressUnit: '%' | '°C';
  plannedEnergyKWh: number;
  deadlineAtMs: number;
}): DeadlinePlanMockupPayload['timeline'] => {
  let projectedProgress = params.progressStart;
  const maxTotal = Math.max(...params.hours.map((hour) => hour.price));
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
  return {
    subtitle: `Known prices until ${formatDeadline(params.deadlineAtMs)}`,
    ariaLabel: `Deadline plan for ${params.device.name}`,
    priceCeiling: formatPrice(maxTotal),
    plannedLoadCeiling: `${params.hardCapKWh.toFixed(1)} kWh`,
    progressCeiling: params.progressUnit === '°C'
      ? `${params.progressTarget.toFixed(1)} °C`
      : `${Math.round(params.progressTarget)}%`,
    progressCeilingValue: params.progressTarget,
    progressFloor: Math.min(normalizedProgressFloor, params.progressTarget - 1),
    progressUnit: params.progressUnit,
    explainer: [
      'This view stops at the deadline.',
      `Planned hours add ${params.plannedEnergyKWh.toFixed(1)} kWh before the target time.`,
    ].join(' '),
    hours: params.hours.map((hour) => {
      const chargerKwh = params.chargeByStartMs.get(hour.startsAtMs) ?? 0;
      if (chargerKwh > 0) {
        projectedProgress = Math.min(params.progressTarget, projectedProgress + chargerKwh * params.progressPerKWh);
      }
      return {
        time: formatHour(hour.startsAtMs),
        price: formatPrice(hour.price),
        priceValue: hour.price,
        tone: resolvePriceTone(hour),
        plan: chargerKwh > 0 ? 'Charge' as const : undefined,
        usage: {
          otherKwh: Math.max(0, hour.plannedOtherKWh),
          chargerKwh,
          hardCapKwh: params.hardCapKWh,
        },
        progress: projectedProgress,
      };
    }),
  };
};

const buildObjectivePayload = (params: ObjectivePlanInput): DeadlinePlanMockupPayload | null => {
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
  const hardCapKWh = resolveHardCapKWh(params.bootstrap);
  const firstChargingHour = hours.find((hour) => chargeByStartMs.has(hour.startsAtMs));
  const plannedEnergyKWh = Array.from(chargeByStartMs.values()).reduce((sum, value) => sum + value, 0);
  const hoursLeft = Math.max(0, Math.ceil((deadlineAtMs - nowMs) / ONE_HOUR_MS));

  return {
    hero: buildHero({
      device,
      objective,
      firstChargingHour,
      deadlineAtMs,
      energyNeededKWh: energy.energyNeededKWh,
      usefulPowerKw,
      hoursLeft,
      confidence: energy.confidence,
      nowMs,
    }),
    timeline: buildTimeline({
      device,
      hours,
      chargeByStartMs,
      hardCapKWh,
      progressStart: progress.currentValue,
      progressTarget: progress.targetValue,
      progressPerKWh,
      progressUnit: progress.unit,
      plannedEnergyKWh,
      deadlineAtMs,
    }),
  };
};

export const mountDeadlinePlanMockup = async (): Promise<void> => {
  const surface = document.getElementById('deadline-plan-mockup-root');
  if (!surface) return;

  initDeadlinePlanClose();
  renderDeadlinePlanMockup(surface, { status: 'loading' });
  try {
    const [bootstrap, devicesPayload] = await Promise.all([
      callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH),
      callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH),
    ]);
    let prices = bootstrap.prices;
    try {
      prices = await callApi<SettingsUiPricesPayload>('GET', SETTINGS_UI_PRICES_PATH);
    } catch {
      prices = bootstrap.prices;
    }
    const payload = buildObjectivePayload({
      bootstrap,
      deviceId: new URLSearchParams(window.location.search).get('deviceId'),
      devices: devicesPayload.devices,
      prices,
    });
    renderDeadlinePlanMockup(surface, payload
      ? { status: 'ready', payload }
      : { status: 'error', message: 'Deadline plan data is not available for this device.' });
  } catch {
    renderDeadlinePlanMockup(surface, {
      status: 'error',
      message: 'Deadline plan data is not available for this device.',
    });
  }
};

export const testExports = {
  buildObjectivePayload,
  resolveDeadlineAtMs,
};
