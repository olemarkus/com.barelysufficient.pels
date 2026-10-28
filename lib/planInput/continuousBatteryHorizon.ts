import type { BatteryEnergyPeriod } from '../../packages/contracts/src/batteryPlan';
import type { ContinuousBatteryPlanConfig } from '../../packages/contracts/src/continuousBatteryPlan';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { PriceTimeline, PriceTimelinePeriod, PriceTimelineRead } from '../../packages/contracts/src/priceTimeline';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { isBatteryPowerLimitEnabled } from '../../packages/shared-domain/src/settings/batteryPowerLimit';
import type { BatteryControlOwner } from '../ports/batteryControlOwner';
import { resolveBatterySolarScope, type BatterySolarScopeSource } from '../battery/batterySolarScope';
import type {
  ContinuousBatteryEnergyHorizon, ContinuousBatteryHorizonRead, ContinuousBatteryPlanSource,
} from '../ports/continuousBatteryPlan';
import { resolvePlanningCeilingKw } from '../power/capacityModel';
import type { PvForecastSourcePort } from '../solar/pvForecastSource';
import type { PlanInputSnapshotDevice } from './runtimeDeviceRead';
import {
  reservationEnergy, reservationPowerKW, taskReservations, tasksForDevices, type BatteryTaskReservation,
} from './batteryTaskReservations';

const HOUR_MS = 60 * 60 * 1000;

/** One home's owner reads; the projection joins them, battery owns the resulting economic choice. */
export type ContinuousBatteryHorizonSources = {
  getNowMs(): number;
  /** Main-home members resolved by the membership owner; includes no meter-area devices. */
  getDevices(): readonly PlanInputSnapshotDevice[];
  getControl(): BatteryControlOwner;
  getControllableDevices(): Readonly<Record<string, boolean>>;
  getPriceTimeline(): PriceTimelineRead;
  getPowerLimitSettings(): PowerLimitSettings;
  getActiveTasks(): DeferredObjectiveActivePlansV1;
  solarScope: BatterySolarScopeSource;
  getSolarForecast(): Pick<PvForecastSourcePort, 'forecast'>;
  getBackgroundKWh(hourStartMs: number): number | undefined;
};

/** The forecast's gross background excludes batteries and managed loads. Standing managed
 * draw uses the accepted current draw as a persistence forecast; smart-task devices use
 * their exact committed reservations instead. Missing reads never become zero demand. */
function standingManagedKW(
  devices: readonly PlanInputSnapshotDevice[],
  tasks: DeferredObjectiveActivePlansV1,
  nowMs: number,
): number {
  const activeTaskIds = new Set(Object.values(tasks.plansByDeviceId)
    .filter(task => task.deadlineAtMs > nowMs && task.liveCompletion.kind !== 'satisfied')
    .map(task => task.deviceId));
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
    readHorizon: (deviceId, config): ContinuousBatteryHorizonRead => readHorizon(sources, deviceId, config),
  };
}

function readHorizon(
  sources: ContinuousBatteryHorizonSources,
  deviceId: string,
  config: ContinuousBatteryPlanConfig,
): ContinuousBatteryHorizonRead {
  const devices = sources.getDevices();
  const device = devices.find(candidate => candidate.id === deviceId);
  const control = sources.getControl().readControl(deviceId);
  if (control.kind !== 'setpoint' || !control.admissible
    || !isBatteryPowerLimitEnabled(sources.getControllableDevices(), deviceId)
    || !device?.managed) return { kind: 'waiting', reason: 'control_unavailable' };
  const level = device.batteryLevel;
  if (!device.available || level === undefined || device.batteryPower === undefined) {
    return { kind: 'waiting', reason: 'battery_unavailable' };
  }
  const prices = sources.getPriceTimeline();
  if (prices.state !== 'ready') return { kind: 'waiting', reason: 'prices_unavailable' };
  if (prices.priceUnit.trim().toLowerCase() !== config.priceUnit.trim().toLowerCase()) {
    return { kind: 'waiting', reason: 'price_unit_changed' };
  }
  const periodRead = buildEnergyPeriods(sources, prices, devices, control.chargeCeilingW / 1000);
  if (periodRead.kind === 'waiting') return periodRead;
  const { periods } = periodRead;
  const cheapestImport = Math.max(0, Math.min(...periods.map(period => period.importPrice)));
  const horizon: ContinuousBatteryEnergyHorizon = {
    battery: {
      capacityKWh: config.usableCapacityKWh,
      storedEnergyKWh: config.usableCapacityKWh * level.percent / 100,
      minimumEnergyKWh: config.usableCapacityKWh * config.minimumReservePercent / 100,
      maxChargeKW: Math.min(control.range.maxW, control.chargeCeilingW) / 1000,
      maxDischargeKW: Math.min(-control.range.minW, control.deliveryCeilingW) / 1000,
      roundTripEfficiency: config.roundTripEfficiency,
      wearCostPerKWh: config.wearCostPerKWh,
      terminalValuePerKWh: Math.max(0, cheapestImport - config.wearCostPerKWh) * Math.sqrt(config.roundTripEfficiency),
    },
    periods,
  };
  return { kind: 'ready', horizon, priceUnit: prices.priceUnit };
}


type PriceSpan = { price: PriceTimelinePeriod; startsAtMs: number; endsAtMs: number };
type WaitingHorizon = Extract<ContinuousBatteryHorizonRead, { kind: 'waiting' }>;
type PeriodRead = { kind: 'ready'; periods: ContinuousBatteryEnergyHorizon['periods'] } | WaitingHorizon;
type HourRead = { kind: 'ready'; backgroundKWh: number; solarKWh: number } | WaitingHorizon;

function priceCuts(startMs: number, endMs: number, reservations: readonly BatteryTaskReservation[]): number[] {
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
  reservations: readonly BatteryTaskReservation[],
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
  devices: readonly PlanInputSnapshotDevice[],
  hardwareChargeKW: number,
): PeriodRead {
  const nowMs = sources.getNowMs();
  const tasks = tasksForDevices(sources.getActiveTasks(), devices);
  const solarScope = resolveBatterySolarScope(sources.solarScope);
  if (solarScope === 'shared') return { kind: 'waiting', reason: 'solar_scope_shared' };
  const reservations = taskReservations(tasks, nowMs);
  if (reservations === 'waiting') return { kind: 'waiting', reason: 'smart_tasks_planning' };
  const standingKW = standingManagedKW(devices, tasks, nowMs);
  const planningCeiling = resolvePlanningCeilingKw(sources.getPowerLimitSettings());
  const solarByHour = new Map<number, number | undefined>();
  let periods: BatteryEnergyPeriod[] = [];
  for (const span of priceSpans(prices.periods, nowMs, reservations)) {
    const hourStartMs = Math.floor(span.startsAtMs / HOUR_MS) * HOUR_MS;
    const hour = readHour(sources, hourStartMs, solarByHour, solarScope === 'main');
    if (hour.kind === 'waiting') return hour;
    if (hour.solarKWh > 0 && span.price.exportPrice === undefined) {
      return { kind: 'waiting', reason: 'prices_unavailable' };
    }
    const durationMs = span.endsAtMs - span.startsAtMs;
    const fraction = durationMs / HOUR_MS;
    const otherManagedDemandKWh = standingKW * fraction
      + reservationEnergy(reservations, span.startsAtMs, span.endsAtMs);
    const reservedKW = reservationPowerKW(reservations, span.startsAtMs, span.endsAtMs);
    const chargeRoomKW = planningCeiling === null ? hardwareChargeKW
      : planningCeiling + hour.solarKWh - hour.backgroundKWh - standingKW - reservedKW;
    periods = periods.concat({
      startsAtMs: span.startsAtMs,
      durationMs,
      importPrice: span.price.importPrice,
      exportPrice: span.price.exportPrice ?? 0, // No forecast export: this price cannot affect the objective.
      householdDemandKWh: hour.backgroundKWh * fraction,
      otherManagedDemandKWh,
      solarKWh: hour.solarKWh * fraction,
      gridImportLimitKW: planningCeiling
        ?? hour.backgroundKWh + otherManagedDemandKWh / fraction + hardwareChargeKW,
      maxChargeKW: Math.max(0, Math.min(hardwareChargeKW, chargeRoomKW)),
    });
  }
  const [firstPeriod, ...remainingPeriods] = periods;
  if (firstPeriod === undefined) return { kind: 'waiting', reason: 'prices_unavailable' };
  return { kind: 'ready', periods: [firstPeriod, ...remainingPeriods] };
}
