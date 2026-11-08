import type { BatteryEnergyPeriod } from '../../packages/contracts/src/batteryPlan';
import type { ContinuousBatteryPlanConfig } from '../../packages/contracts/src/continuousBatteryPlan';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { TaskReservationSource } from '../ports/taskReservations';
import type { PriceTimeline, PriceTimelinePeriod, PriceTimelineRead } from '../../packages/contracts/src/priceTimeline';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { isBatteryPowerLimitEnabled } from '../../packages/shared-domain/src/settings/batteryPowerLimit';
import { planningPowerCeiling } from '../../packages/shared-domain/src/settings/powerLimits';
import type { BatteryControlOwner } from '../ports/batteryControlOwner';
import { resolveBatterySolarScope, type BatterySolarScopeSource } from './batterySolarScope';
import type {
  ContinuousBatteryEnergyHorizon, ContinuousBatteryExportPricing, ContinuousBatteryHorizonRead,
  ContinuousBatteryPlanSource,
} from '../ports/continuousBatteryPlan';
import { reservationEnergy, reservationPowerKW } from './batteryTaskReservations';

const HOUR_MS = 60 * 60 * 1000;

/** One home's owner reads; the projection joins them, battery owns the resulting economic choice. */
export type ContinuousBatteryHorizonSources = {
  getNowMs(): number;
  /** Main-home members resolved by the membership owner; includes no meter-area devices. */
  getDevices(): readonly DeviceSurfaces[];
  getControl(): BatteryControlOwner;
  getControllableDevices(): Readonly<Record<string, boolean>>;
  /** The home's planned devices in the owner's order (`HomeModeCatalog.getPrioritiesForDevices`). */
  getPrioritiesForDevices(deviceIds: readonly string[]): { getPriority(deviceId: string): number };
  getPriceTimeline(): PriceTimelineRead;
  getPowerLimitSettings(): PowerLimitSettings;
  taskReservations: TaskReservationSource;
  solarScope: BatterySolarScopeSource;
  /** The selected solar forecast source's hourly generation. */
  getSolarForecast(): { forecast(hourStarts: readonly number[]): readonly { generationKwh: number }[] };
  getBackgroundKWh(hourStartMs: number): number | undefined;
};

/** The forecast's gross background excludes batteries and managed loads. Standing managed
 * draw uses the accepted current draw as a persistence forecast; smart-task devices use
 * their exact committed reservations instead. Missing reads never become zero demand. */
function standingManagedKW(
  devices: readonly DeviceSurfaces[],
  activeTaskIds: ReadonlySet<string>,
): number {
  return devices.reduce((total, device) => (
    device.managed && !device.isBatteryOrSolar && !activeTaskIds.has(device.id) && hasObservedMeasuredPower(device)
      ? total + Math.max(0, device.measuredPowerKw)
      : total
  ), 0);
}

export function createContinuousBatteryPlanSource(
  sources: ContinuousBatteryHorizonSources,
): ContinuousBatteryPlanSource {
  return {
    getNowMs: () => sources.getNowMs(),
    // The mode catalog's order has unique ranks, so it needs no tiebreak.
    orderByPriority: (deviceIds) => {
      const priorities = sources.getPrioritiesForDevices(deviceIds);
      return [...deviceIds].sort((left, right) => priorities.getPriority(left) - priorities.getPriority(right));
    },
    readHorizons: (nowMs, batteries) => readHorizons(sources, nowMs, batteries),
  };
}

type ReadyBattery = {
  deviceId: string;
  config: ContinuousBatteryPlanConfig;
  control: Extract<ReturnType<BatteryControlOwner['readControl']>, { kind: 'setpoint' }>;
  levelPercent: number;
};

/**
 * Every enabled battery's horizon from one set of reads at one instant, so all
 * of them share the same periods: the house's demand, solar, prices and limits.
 * A battery that cannot plan waits on its own; the others still plan.
 */
function readHorizons(
  sources: ContinuousBatteryHorizonSources,
  nowMs: number,
  batteries: readonly { deviceId: string; config: ContinuousBatteryPlanConfig }[],
): ReadonlyMap<string, ContinuousBatteryHorizonRead> {
  const devices = sources.getDevices();
  const reads = new Map<string, ContinuousBatteryHorizonRead>();
  const ready = batteries.flatMap(({ deviceId, config }): ReadyBattery[] => {
    const battery = readBattery(sources, devices, deviceId, config);
    if (!('kind' in battery)) return [battery];
    reads.set(deviceId, battery);
    return [];
  });
  if (ready.length === 0) return reads;
  const prices = sources.getPriceTimeline();
  if (prices.state !== 'ready') {
    for (const { deviceId } of ready) reads.set(deviceId, { kind: 'waiting', reason: 'prices_unavailable' });
    return reads;
  }
  // Without a power limit the import ceiling is what every battery charging at
  // once could draw, so no battery's charge is cut by another's.
  const fleetChargeKW = ready.reduce((total, battery) => total + battery.control.chargeCeiling.everyLevelW / 1000, 0);
  const periodRead = buildEnergyPeriods(sources, prices, devices, fleetChargeKW, nowMs);
  for (const battery of ready) {
    if (prices.priceUnit.trim().toLowerCase() !== battery.config.priceUnit.trim().toLowerCase()) {
      reads.set(battery.deviceId, { kind: 'waiting', reason: 'price_unit_changed' });
    } else if (periodRead.kind === 'waiting') {
      reads.set(battery.deviceId, periodRead);
    } else {
      reads.set(battery.deviceId, {
        kind: 'ready',
        horizon: { battery: batteryModel(battery, periodRead.periods), periods: periodRead.periods },
        priceUnit: prices.priceUnit,
        exportPricing: periodRead.exportPricing,
      });
    }
  }
  return reads;
}

function readBattery(
  sources: ContinuousBatteryHorizonSources,
  devices: readonly DeviceSurfaces[],
  deviceId: string,
  config: ContinuousBatteryPlanConfig,
): ReadyBattery | WaitingHorizon {
  const device = devices.find(candidate => candidate.id === deviceId);
  const control = sources.getControl().readControl(deviceId);
  if (control.kind !== 'setpoint' || !control.admissible
    || !isBatteryPowerLimitEnabled(sources.getControllableDevices(), deviceId)
    || !device?.managed) return { kind: 'waiting', reason: 'control_unavailable' };
  const level = device.batteryLevel;
  if (!device.available || level === undefined || device.batteryPower === undefined) {
    return { kind: 'waiting', reason: 'battery_unavailable' };
  }
  return { deviceId, config, control, levelPercent: level.percent };
}

function batteryModel(
  { config, control, levelPercent }: ReadyBattery,
  periods: ContinuousBatteryEnergyHorizon['periods'],
): ContinuousBatteryEnergyHorizon['battery'] {
  const { chargeCeiling } = control;
  const cheapestImport = Math.max(0, Math.min(...periods.map(period => period.importPrice)));
  return {
    capacityKWh: config.usableCapacityKWh,
    storedEnergyKWh: config.usableCapacityKWh * levelPercent / 100,
    minimumEnergyKWh: config.usableCapacityKWh * config.minimumReservePercent / 100,
    maxChargeKW: Math.min(control.range.maxW, chargeCeiling.everyLevelW) / 1000,
    chargeTaper: chargeCeiling.planningTaper.map(step => ({
      fromEnergyKWh: config.usableCapacityKWh * step.fromPercent / 100,
      maxChargeKW: Math.min(control.range.maxW, step.ceilingW) / 1000,
    })),
    maxDischargeKW: Math.min(-control.range.minW, control.deliveryCeilingW) / 1000,
    roundTripEfficiency: config.roundTripEfficiency,
    wearCostPerKWh: config.wearCostPerKWh,
    terminalValuePerKWh: Math.max(0, cheapestImport - config.wearCostPerKWh) * Math.sqrt(config.roundTripEfficiency),
  };
}

type PriceSpan = { price: PriceTimelinePeriod; startsAtMs: number; endsAtMs: number };
type WaitingHorizon = Extract<ContinuousBatteryHorizonRead, { kind: 'waiting' }>;
type PeriodRead = {
  kind: 'ready'; periods: ContinuousBatteryEnergyHorizon['periods']; exportPricing: ContinuousBatteryExportPricing;
} | WaitingHorizon;
type HourRead = { kind: 'ready'; backgroundKWh: number; solarKWh: number } | WaitingHorizon;

function priceCuts(
  startMs: number,
  endMs: number,
  reservations: readonly { startMs: number; endMs: number }[],
): number[] {
  const boundaries = new Set([startMs, endMs]);
  for (let hour = (Math.floor(startMs / HOUR_MS) + 1) * HOUR_MS; hour < endMs; hour += HOUR_MS) {
    boundaries.add(hour);
  }
  for (const reservation of reservations) {
    if (reservation.startMs > startMs && reservation.startMs < endMs) boundaries.add(reservation.startMs);
    if (reservation.endMs > startMs && reservation.endMs < endMs) boundaries.add(reservation.endMs);
  }
  return [...boundaries].sort((left, right) => left - right);
}

function* priceSpans(
  prices: readonly PriceTimelinePeriod[],
  nowMs: number,
  reservations: readonly { startMs: number; endMs: number }[],
): Generator<PriceSpan> {
  let cursor = nowMs;
  let count = 0;
  for (const price of prices) {
    const publishedStart = Date.parse(price.startsAt);
    const endMs = publishedStart + price.durationMinutes * 60_000;
    if (endMs <= nowMs) continue;
    const startMs = Math.max(nowMs, publishedStart);
    if (startMs > cursor || count >= 192) return;
    let fromMs = startMs;
    for (const toMs of priceCuts(startMs, endMs, reservations).slice(1)) {
      if (count >= 192) return;
      yield { price, startsAtMs: fromMs, endsAtMs: toMs };
      count += 1;
      cursor = toMs;
      fromMs = toMs;
    }
  }
}

function readHour(
  sources: ContinuousBatteryHorizonSources,
  hourStartMs: number,
  solarByHour: Map<number, number | undefined>,
  solarPresent: boolean,
): HourRead {
  const backgroundKWh = sources.getBackgroundKWh(hourStartMs);
  if (backgroundKWh === undefined) return { kind: 'waiting', reason: 'background_unavailable' };
  if (!solarPresent) return { kind: 'ready', backgroundKWh, solarKWh: 0 };
  if (!solarByHour.has(hourStartMs)) {
    solarByHour.set(hourStartMs, sources.getSolarForecast().forecast([hourStartMs])[0]?.generationKwh);
  }
  const solarKWh = solarByHour.get(hourStartMs);
  if (solarKWh === undefined) return { kind: 'waiting', reason: 'forecast_unavailable' };
  return { kind: 'ready', backgroundKWh, solarKWh };
}

function buildEnergyPeriods(
  sources: ContinuousBatteryHorizonSources,
  prices: PriceTimeline,
  devices: readonly DeviceSurfaces[],
  hardwareChargeKW: number,
  nowMs: number,
): PeriodRead {
  const managedDeviceIds = new Set(devices.filter(device => device.managed).map(device => device.id));
  const tasks = sources.taskReservations.read(nowMs, managedDeviceIds);
  const solarScope = resolveBatterySolarScope(sources.solarScope);
  if (solarScope === 'shared') return { kind: 'waiting', reason: 'solar_scope_shared' };
  if (tasks.kind === 'waiting') return { kind: 'waiting', reason: 'smart_tasks_planning' };
  const standingKW = standingManagedKW(devices, tasks.taskDeviceIds);
  const reservationBounds = [...tasks.energy, ...tasks.admission];
  // The power owner's shared arithmetic (`resolvePlanningCeilingKw`): the lower enabled limit, null when none is.
  const planningCeiling = planningPowerCeiling(sources.getPowerLimitSettings())?.kw ?? null;
  const solarByHour = new Map<number, number | undefined>();
  let periods: BatteryEnergyPeriod[] = [];
  let exportPricing: ContinuousBatteryExportPricing = 'complete';
  for (const span of priceSpans(prices.periods, nowMs, reservationBounds)) {
    const hourStartMs = Math.floor(span.startsAtMs / HOUR_MS) * HOUR_MS;
    const hour = readHour(sources, hourStartMs, solarByHour, solarScope === 'main');
    if (hour.kind === 'waiting') return hour;
    // A home without an export price still gets a plan: its unquoted solar
    // export is worth 0 to it, so the plan keeps solar it can store.
    if (span.price.exportPrice === undefined) {
      if (hour.solarKWh > 0) exportPricing = 'unpriced_solar';
      else if (exportPricing === 'complete') exportPricing = 'incomplete';
    }
    const durationMs = span.endsAtMs - span.startsAtMs;
    const fraction = durationMs / HOUR_MS;
    const otherManagedDemandKWh = standingKW * fraction
      + reservationEnergy(tasks.energy, span.startsAtMs, span.endsAtMs);
    const reservedKW = reservationPowerKW(tasks.admission, span.startsAtMs, span.endsAtMs);
    const chargeRoomKW = planningCeiling === null ? hardwareChargeKW
      : planningCeiling + hour.solarKWh - hour.backgroundKWh - standingKW - reservedKW;
    periods = periods.concat({
      startsAtMs: span.startsAtMs,
      durationMs,
      importPrice: span.price.importPrice,
      // No quote: household planning values this period's export at 0. Without
      // solar it exports nothing, so the zero cannot affect its objective; with
      // solar it stores what it can rather than export for nothing. It never
      // authorizes selling: an absent quote leaves the horizon short of
      // `complete`, and selling waits for complete quotes.
      exportPrice: span.price.exportPrice ?? 0,
      householdDemandKWh: hour.backgroundKWh * fraction,
      otherManagedDemandKWh,
      solarKWh: hour.solarKWh * fraction,
      gridImportLimitKW: planningCeiling
        ?? hour.backgroundKWh + otherManagedDemandKWh / fraction + hardwareChargeKW,
      maxChargeKW: Math.max(0, chargeRoomKW),
      otherStorageKWh: 0,
      laterSupplyKW: 0,
    });
  }
  const [firstPeriod, ...remainingPeriods] = periods;
  if (firstPeriod === undefined) return { kind: 'waiting', reason: 'prices_unavailable' };
  return { kind: 'ready', periods: [firstPeriod, ...remainingPeriods], exportPricing };
}
