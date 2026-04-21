import { shouldEmitOnChange } from '../logging/logDedupe';
import type { Logger } from '../utils/types';
import type { DeviceMeasuredPowerObservation } from './deviceMeasuredPowerReader';

const MIN_METER_DELTA_HOURS = 1 / 3600; // Require at least 1 second between readings

type MeasuredPowerSource = 'measure_power' | 'meter_power' | 'homey_energy';
type DeviceMeasuredPowerResolution = {
  measuredPowerKw?: number;
  observedAtMs?: number;
};

export class DeviceMeasuredPowerResolver {
  private readonly lastMeterEnergyKwh: Record<string, { kwh: number; ts: number }> = {};
  private readonly lastResolvedSourceByDevice = new Map<string, { signature: string; emittedAt: number }>();

  constructor(private readonly deps: {
    logger: Logger;
    lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
    minSignificantPowerW: number;
    getNow?: () => number;
  }) {}

  resolve(params: {
    deviceId: string;
    deviceLabel: string;
    observation: DeviceMeasuredPowerObservation;
  }): DeviceMeasuredPowerResolution {
    const {
      deviceId,
      deviceLabel,
      observation,
    } = params;
    const now = this.deps.getNow?.() ?? Date.now();
    const selectedSource = this.selectSource(observation);

    this.logSourceChange({
      deviceId,
      deviceLabel,
      source: selectedSource,
      now,
    });

    if (selectedSource === 'measure_power') {
      return this.resolveDirectWatts({
        deviceId,
        deviceLabel,
        watts: observation.measurePowerW,
        observedAtMs: observation.measurePowerObservedAtMs,
        now,
      });
    }
    if (selectedSource === 'meter_power') {
      return this.resolveMeterDelta({
        deviceId,
        deviceLabel,
        meterPowerKwh: observation.meterPowerKwh,
        observedAtMs: observation.meterPowerObservedAtMs,
        now,
      });
    }
    if (selectedSource === 'homey_energy') {
      return this.resolveDirectWatts({
        deviceId,
        deviceLabel,
        watts: observation.homeyEnergyLiveW,
        observedAtMs: observation.homeyEnergyObservedAtMs,
        now,
      });
    }
    return {};
  }

  private selectSource(observation: DeviceMeasuredPowerObservation): MeasuredPowerSource | null {
    if (typeof observation.measurePowerW === 'number' && Number.isFinite(observation.measurePowerW)) {
      return 'measure_power';
    }
    if (typeof observation.meterPowerKwh === 'number' && Number.isFinite(observation.meterPowerKwh)) {
      return 'meter_power';
    }
    if (typeof observation.homeyEnergyLiveW === 'number' && Number.isFinite(observation.homeyEnergyLiveW)) {
      return 'homey_energy';
    }
    return null;
  }

  private resolveDirectWatts(params: {
    deviceId: string;
    deviceLabel: string;
    watts: number | undefined;
    observedAtMs?: number;
    now: number;
  }): DeviceMeasuredPowerResolution {
    const {
      deviceId,
      deviceLabel,
      watts,
      observedAtMs,
      now,
    } = params;
    if (typeof watts !== 'number' || !Number.isFinite(watts)) {
      return {};
    }
    if (watts === 0) {
      return { measuredPowerKw: 0, observedAtMs };
    }
    if (watts > this.deps.minSignificantPowerW) {
      const measuredPowerKw = watts / 1000;
      this.deps.lastPositiveMeasuredPowerKw[deviceId] = { kw: measuredPowerKw, ts: now };
      return { measuredPowerKw, observedAtMs };
    }
    this.deps.logger.debug(`Power estimate: ignoring low reading for ${deviceLabel}: ${watts} W`);
    return { observedAtMs };
  }

  private resolveMeterDelta(params: {
    deviceId: string;
    deviceLabel: string;
    meterPowerKwh: number | undefined;
    observedAtMs?: number;
    now: number;
  }): DeviceMeasuredPowerResolution {
    const {
      deviceId,
      deviceLabel,
      meterPowerKwh,
      observedAtMs,
      now,
    } = params;
    if (typeof meterPowerKwh !== 'number' || !Number.isFinite(meterPowerKwh)) {
      return {};
    }

    const previous = this.lastMeterEnergyKwh[deviceId];
    this.lastMeterEnergyKwh[deviceId] = { kwh: meterPowerKwh, ts: now };
    if (!previous) {
      return { observedAtMs };
    }
    if (meterPowerKwh < previous.kwh) {
      this.deps.logger.debug(
        `Power estimate: meter reset for ${deviceLabel} (prev ${previous.kwh}, now ${meterPowerKwh})`,
      );
      return { observedAtMs };
    }

    const deltaHours = (now - previous.ts) / (1000 * 60 * 60);
    if (!Number.isFinite(deltaHours) || deltaHours < MIN_METER_DELTA_HOURS) {
      return { observedAtMs };
    }

    const deltaKwh = meterPowerKwh - previous.kwh;
    const measuredPowerKw = deltaKwh / deltaHours;
    if (!Number.isFinite(measuredPowerKw)) {
      return { observedAtMs };
    }
    if (measuredPowerKw <= 0) {
      return { measuredPowerKw: 0, observedAtMs };
    }

    const measuredW = measuredPowerKw * 1000;
    if (measuredW < this.deps.minSignificantPowerW) {
      this.deps.logger.debug(
        `Power estimate: ignoring low meter delta for ${deviceLabel}: ${measuredW.toFixed(1)} W`,
      );
      return { observedAtMs };
    }

    this.deps.lastPositiveMeasuredPowerKw[deviceId] = { kw: measuredPowerKw, ts: now };
    return { measuredPowerKw, observedAtMs };
  }

  private logSourceChange(params: {
    deviceId: string;
    deviceLabel: string;
    source: MeasuredPowerSource | null;
    now: number;
  }): void {
    const { deviceId, deviceLabel, source, now } = params;
    const signature = JSON.stringify({ source });
    if (!shouldEmitOnChange({
      state: this.lastResolvedSourceByDevice,
      key: deviceId,
      signature,
      now,
    })) {
      return;
    }

    this.deps.logger.structuredLog?.debug({
      event: 'device_measured_power_source_changed',
      deviceId,
      deviceName: deviceLabel,
      source: source ?? undefined,
    });
  }
}
