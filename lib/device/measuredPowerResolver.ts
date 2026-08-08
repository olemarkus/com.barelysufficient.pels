import { shouldEmitOnChange } from '../logging/logDedupe';
import type { Logger } from '../utils/types';
import type { DeviceMeasuredPowerObservation } from './measuredPowerReader';
import { getLogger } from '../logging/logger';
import { normalizeMeasuredPowerKw } from '../../packages/shared-domain/src/measuredPowerObservedState';

const moduleLogger = getLogger('device/measured-power');

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
    watts: number | undefined;
    observedAtMs?: number;
    now: number;
  }): DeviceMeasuredPowerResolution {
    const {
      deviceId,
      watts,
      observedAtMs,
      now,
    } = params;
    // `normalizeMeasuredPowerKw` is the shared rule every write seam applies:
    // finite and non-negative. A rejected reading is ABSENT, never 0 — "no
    // reading" and "drawing nothing" are different facts, and conflating them is
    // what let a device measuring a true 0 W be credited its nameplate.
    //
    // A negative is dropped for every device, including a home battery or solar
    // panel that is exporting, and that loses nothing: PV/battery production has
    // its own producer, `extractSolarProductionState` (`managerEnergy.ts`) feeding
    // `SolarProductionProducer`, which reads the raw `measure_power` capability
    // and owns the sign. This resolver answers a narrower question — what is this
    // device pulling FROM the house right now — and for an exporting device the
    // honest answer is "no draw reading".
    //
    // The `observedAtMs`-only return distinguishes "the capability reported, but
    // not a usable draw" from "nothing reported at all" (`{}`), which the
    // freshness bookkeeping downstream relies on.
    if (typeof watts !== 'number' || !Number.isFinite(watts)) {
      return {};
    }
    const normalized = normalizeMeasuredPowerKw(watts / 1000);
    if (normalized === null) {
      return { observedAtMs };
    }
    // Every accepted reading resolves to its own value, including a few watts of
    // standby. A significance floor used to drop `0 < w <= 5` as
    // `power_estimate_low_reading_ignored`, which made "drawing 3 W"
    // indistinguishable from "has no `measure_power`" — and absence is what sends
    // a consumer to a RATED-power fallback, so a 3 W standby draw could be booked
    // as kilowatts. The reading is the answer; report it.
    const measuredPowerKw = normalized;
    if (measuredPowerKw > 0) {
      this.deps.lastPositiveMeasuredPowerKw[deviceId] = { kw: measuredPowerKw, ts: now };
    }
    return { measuredPowerKw, observedAtMs };
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
      this.deps.logger.debug({
        event: 'power_estimate_meter_reset',
        deviceId,
        deviceLabel,
        previousKwh: previous.kwh,
        meterPowerKwh,
      });
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

    // As in `resolveDirectWatts`: a small but real delta is reported, not
    // dropped. Dropping it produced absence, and absence is what licenses a
    // consumer to substitute rated power.
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

    (this.deps.logger.structuredLog ?? moduleLogger).debug({
      event: 'device_measured_power_source_changed',
      deviceId,
      deviceName: deviceLabel,
      source: source ?? undefined,
    });
  }
}
