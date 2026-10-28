import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { getZonedParts } from '../../packages/shared-domain/src/utils/dateUtils';
import { resolveBatterySolarScope, type BatterySolarScopeSource } from './batterySolarScope';

const SMOOTHING_MS = 30 * 60 * 1000;
const MAX_SAMPLE_WEIGHT_MS = 5 * 60 * 1000;

/** A resolved whole-home power balance, all terms from accepted observations. */
export type BatteryDemandSample = {
  atMs: number;
  netImportKW: number;
  solarKW: number;
  batteryPowerKW: number;
  managedPowerKW: number;
};

type BackgroundObservation = { atMs: number; powerKW: number };

/**
 * Battery-neutral background demand. Storage is removed from the measured power
 * balance before learning, so charging cannot teach itself a future load and
 * supplying cannot hide household demand. Known managed draw is forecast by the
 * commitment owner separately; unmetered loads remain in this background.
 *
 * The prototype learns a bounded local-hour profile while running. Unobserved
 * hours use the recently measured background, rather than fabricated zeroes.
 * No observation means no forecast. Day length is never assumed to be 24 hours.
 */
export class BatteryDemandForecaster {
  private latest: BackgroundObservation | undefined;
  private readonly hours = new Map<number, BackgroundObservation>();

  constructor(
    private readonly getDevices: () => readonly DeviceSurfaces[],
    private readonly getTimeZone: () => string,
    private readonly solarScope: BatterySolarScopeSource,
    private readonly isPlanningEnabled: () => boolean,
  ) {}

  /** Main meter tap. A missing battery or solar read skips learning, retaining accepted history. */
  recordNetSample(netPowerW: number, generationW: number | undefined, atMs: number): void {
    if (!this.isPlanningEnabled()) return;
    const devices = this.getDevices();
    const batteries = devices.filter((device) => device.deviceClass === 'battery');
    if (batteries.length === 0) return;
    const solarScope = resolveBatterySolarScope(this.solarScope);
    if (solarScope === 'shared' || (solarScope === 'main' && generationW === undefined)) return;
    let batteryPowerKW = 0;
    for (const battery of batteries) {
      if (!battery.available || battery.batteryPower === undefined) return;
      batteryPowerKW += battery.batteryPower.signedW / 1000;
    }
    const managedPowerKW = devices.reduce((total, device) => (
      device.managed && !device.isBatteryOrSolar && hasObservedMeasuredPower(device)
        ? total + device.measuredPowerKw : total
    ), 0);
    this.observe({
      atMs, netImportKW: netPowerW / 1000, solarKW: solarScope === 'none' ? 0 : (generationW ?? 0) / 1000,
      batteryPowerKW, managedPowerKW,
    });
  }

  observe(sample: BatteryDemandSample): void {
    if (this.latest !== undefined && sample.atMs <= this.latest.atMs) return;
    const powerKW = Math.max(0, sample.netImportKW + sample.solarKW - sample.batteryPowerKW - sample.managedPowerKW);
    const previous = this.latest;
    const elapsedMs = previous === undefined
      ? SMOOTHING_MS : Math.min(MAX_SAMPLE_WEIGHT_MS, sample.atMs - previous.atMs);
    const weight = previous === undefined ? 1 : 1 - Math.exp(-elapsedMs / SMOOTHING_MS);
    const recentKW = previous === undefined ? powerKW : previous.powerKW + weight * (powerKW - previous.powerKW);
    this.latest = { atMs: sample.atMs, powerKW: recentKW };
    const hour = getZonedParts(new Date(sample.atMs), this.getTimeZone()).hour;
    const observed = this.hours.get(hour);
    this.hours.set(hour, {
      atMs: sample.atMs,
      powerKW: observed === undefined ? powerKW : observed.powerKW + weight * (powerKW - observed.powerKW),
    });
  }

  /** Expected background kWh for a full hour; callers scale partial periods. */
  forecast(hourStartMs: number): number | undefined {
    const hour = getZonedParts(new Date(hourStartMs), this.getTimeZone()).hour;
    return this.hours.get(hour)?.powerKW ?? this.latest?.powerKW;
  }
}
