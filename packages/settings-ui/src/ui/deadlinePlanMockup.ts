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
  type DeadlinePlanMockupLoadState,
  type DeadlinePlanMockupPayload,
} from './views/DeadlinePlanMockup.tsx';

export const isDeadlinePlanMockupPage = (): boolean => (
  document.getElementById('deadline-plan-mockup-root') !== null
);

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
  const combined = payload.combinedPrices as CombinedPricesLike | null;
  return Array.isArray(combined?.prices)
    ? combined.prices.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.startsAt !== 'string' || !isFiniteNumber(entry.total)) return [];
      return [{
        startsAt: entry.startsAt,
        total: entry.total,
        ...(entry.isCheap === true ? { isCheap: true } : {}),
        ...(entry.isExpensive === true ? { isExpensive: true } : {}),
      }];
    })
    : [];
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

const resolveProgress = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
}): { remainingUnits: number; progressPct: number } | null => {
  const { device, objective } = params;
  if (objective.kind === 'temperature') {
    if (!isFiniteNumber(device.currentTemperature)) return null;
    const remainingUnits = Math.max(0, objective.targetTemperatureC - device.currentTemperature);
    let progressPct = remainingUnits <= 0 ? 100 : 0;
    if (objective.targetTemperatureC > 0) {
      progressPct = Math.min(100, Math.max(0, (device.currentTemperature / objective.targetTemperatureC) * 100));
    }
    return {
      remainingUnits,
      progressPct,
    };
  }

  const percent = device.stateOfCharge?.percent;
  if (!isFiniteNumber(percent)) return null;
  return {
    remainingUnits: Math.max(0, objective.targetPercent - percent),
    progressPct: Math.min(100, Math.max(0, percent)),
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
): number => {
  const match = getDailyBudgetDayByBucket(dailyBudget, startMs);
  if (!match) return 0;
  const uncontrolled = match.day.buckets.plannedUncontrolledKWh?.[match.index];
  const controlled = match.day.buckets.plannedControlledKWh?.[match.index];
  const fallback = match.day.buckets.plannedKWh[match.index];
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
      plannedOtherKWh: resolvePlannedOtherKWh(params.bootstrap.dailyBudget, startsAtMs),
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

const resolvePriceLevel = (price: number, minTotal: number, maxTotal: number): number => {
  const range = Math.max(1, maxTotal - minTotal);
  return Math.round(((price - minTotal) / range) * 100);
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
  progressPct: number;
  progressPerKWh: number;
  plannedEnergyKWh: number;
  deadlineAtMs: number;
}): DeadlinePlanMockupPayload['timeline'] => {
  let projectedProgress = params.progressPct;
  const minTotal = Math.min(...params.hours.map((hour) => hour.price));
  const maxTotal = Math.max(...params.hours.map((hour) => hour.price));
  return {
    title: 'Known-price horizon',
    subtitle: `Known prices until ${formatDeadline(params.deadlineAtMs)}`,
    ariaLabel: `Deadline plan for ${params.device.name}`,
    explainer: [
      'This view stops at the deadline.',
      `Planned hours add ${params.plannedEnergyKWh.toFixed(1)} kWh before the target time.`,
    ].join(' '),
    hours: params.hours.map((hour) => {
      const chargerKwh = params.chargeByStartMs.get(hour.startsAtMs) ?? 0;
      if (chargerKwh > 0) {
        projectedProgress = Math.min(100, projectedProgress + chargerKwh * params.progressPerKWh);
      }
      return {
        time: formatHour(hour.startsAtMs),
        price: formatPrice(hour.price),
        priceLevel: resolvePriceLevel(hour.price, minTotal, maxTotal),
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

  const progress = resolveProgress({ device, objective });
  const profile = resolveProfile(params.bootstrap.power.tracker, deviceId, objective.kind);
  const energy = progress
    ? resolveEnergyNeededKWh({ profile, remainingUnits: progress.remainingUnits })
    : null;
  const usefulPowerKw = resolveUsefulPowerKw(device);
  const hours = collectHorizonHours({
    bootstrap: params.bootstrap,
    deadlineAtMs,
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
    ? (100 - progress.progressPct) / energy.energyNeededKWh
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
      progressPct: progress.progressPct,
      progressPerKWh,
      plannedEnergyKWh,
      deadlineAtMs,
    }),
  };
};

const renderState = (surface: HTMLElement, loadState: DeadlinePlanMockupLoadState): void => {
  renderDeadlinePlanMockup(surface, loadState);
};

const getDeviceIdFromLocation = (): string | null => (
  new URLSearchParams(window.location.search).get('deviceId')
);

export const mountDeadlinePlanMockup = async (): Promise<void> => {
  const surface = document.getElementById('deadline-plan-mockup-root');
  if (!surface) return;

  renderState(surface, { status: 'loading' });
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
      deviceId: getDeviceIdFromLocation(),
      devices: devicesPayload.devices,
      prices,
    });
    renderState(surface, payload
      ? { status: 'ready', payload }
      : { status: 'error', message: 'Deadline plan data is not available for this device.' });
  } catch {
    renderState(surface, { status: 'error', message: 'Deadline plan data is not available for this device.' });
  }
};

export const testExports = {
  buildObjectivePayload,
  resolveDeadlineAtMs,
};
