import { shouldEmitOnChange } from '../logging/logDedupe';
import type { Logger } from '../utils/types';
import type { DeviceMeasuredPowerObservation, MeterEnergyReading } from './measuredPowerReader';
import { getLogger } from '../logging/logger';
import { normalizeMeasuredPowerKw } from '../../packages/shared-domain/src/measuredPowerObservedState';

const moduleLogger = getLogger('device/measured-power');

// Require at least 1 second of OBSERVED time between the two readings a rate is
// derived from, so a pair stamped inside the same second cannot divide by a
// denominator too small to mean anything.
const MIN_METER_DELTA_HOURS = 1 / 3600;

type MeasuredPowerSource = 'measure_power' | 'meter_power' | 'homey_energy';
type DeviceMeasuredPowerResolution = {
  measuredPowerKw?: number;
  observedAtMs?: number;
};

/**
 * The reading the resolver chose to answer from, carrying the typed value it
 * will use. Selecting a SOURCE and then re-checking the value in the branch that
 * handles it was two places answering one question; the union keeps the
 * precedence order and the value together, so the branches take what they are
 * given.
 */
type SelectedReading =
  | { source: 'measure_power' | 'homey_energy'; watts: number; observedAtMs?: number }
  | { source: 'meter_power'; reading: MeterEnergyReading };

export class DeviceMeasuredPowerResolver {
  // The anchor a rate is measured FROM: one dated cumulative reading per device.
  // Dated in OBSERVATION time (the capability's own `lastUpdated`), never in
  // resolve time — see `resolveMeterDelta`.
  private readonly lastMeterEnergy: Record<string, MeterEnergyReading> = {};
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
    const selected = selectReading(observation);

    this.logSourceChange(deviceId, deviceLabel, selected?.source ?? null, now);

    if (!selected) return {};
    if (selected.source === 'meter_power') {
      return this.resolveMeterDelta(deviceId, deviceLabel, selected.reading, now);
    }
    return this.resolveDirectWatts(deviceId, selected.watts, selected.observedAtMs, now);
  }

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
  private resolveDirectWatts(
    deviceId: string,
    watts: number,
    observedAtMs: number | undefined,
    now: number,
  ): DeviceMeasuredPowerResolution {
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

  /**
   * Power from a cumulative energy meter: the energy that accrued between two
   * OBSERVATIONS, over the time between those same two observations.
   *
   * BOTH TERMS COME FROM THE SAME CLOCK. The denominator is observation time
   * (the capability's own `lastUpdated`), never the wall-clock moment this
   * resolver happened to run. Those are different clocks with different
   * cadences: an owning app publishes `meter_power` on its own schedule — a
   * cloud poll can be minutes apart — while this resolver runs on the snapshot
   * refresh, seconds apart. Dividing a poll interval's energy by a refresh
   * interval overstates the rate by the ratio of the two, which is how a ~3.8 kW
   * air conditioner came to report 226 kW in production. `nextLearnedPeak` has
   * no ceiling and holds that figure for thirty days, so it also becomes the
   * expected power the restore axis sizes against and the `≈ … kW when active`
   * the owner reads.
   *
   * THE SAME MISMATCH HAD A QUIETER HALF. Between two pushes the cumulative
   * value has not moved, so the delta was zero over real elapsed time and the
   * device was credited a measured `0 kW` while running — a positive claim that
   * it draws nothing, for most of every poll interval. On one clock that pair
   * spans no window at all, so it resolves to ABSENCE: no reading, last good
   * value carries forward, which is what a gap in a feed is owed. A device whose
   * app re-publishes an unchanged meter still resolves a true `0` there, because
   * its observation time moves while its energy does not.
   *
   * THE ANCHOR ADVANCES ONLY WHEN A PAIR IS CONSUMED (or on a meter reset).
   * Advancing it on a skipped pair would discard that interval's energy for
   * good; leaving it puts that energy into the next window, where it belongs.
   * An observation that carries no meter reading at all never reaches here, so
   * it cannot disturb the anchor either — a later dated reading pairs with the
   * standing one, across the whole span between them.
   */
  private resolveMeterDelta(
    deviceId: string,
    deviceLabel: string,
    reading: MeterEnergyReading,
    now: number,
  ): DeviceMeasuredPowerResolution {
    const { kwh, observedAtMs } = reading;
    const previous = this.lastMeterEnergy[deviceId];
    if (!previous) {
      this.lastMeterEnergy[deviceId] = reading;
      return { observedAtMs };
    }
    if (kwh < previous.kwh) {
      this.deps.logger.debug({
        event: 'power_estimate_meter_reset',
        deviceId,
        deviceLabel,
        previousKwh: previous.kwh,
        meterPowerKwh: kwh,
      });
      this.lastMeterEnergy[deviceId] = reading;
      return { observedAtMs };
    }

    // A non-advancing (or backwards) observation clock yields no window, so the
    // guard below catches the re-read of an unchanged capability as well as a
    // pair stamped inside the same second.
    const deltaHours = (observedAtMs - previous.observedAtMs) / (1000 * 60 * 60);
    if (deltaHours < MIN_METER_DELTA_HOURS) {
      return { observedAtMs };
    }

    this.lastMeterEnergy[deviceId] = reading;
    const measuredPowerKw = (kwh - previous.kwh) / deltaHours;
    if (measuredPowerKw <= 0) {
      return { measuredPowerKw: 0, observedAtMs };
    }

    // As in `resolveDirectWatts`: a small but real delta is reported, not
    // dropped. Dropping it produced absence, and absence is what licenses a
    // consumer to substitute rated power.
    this.deps.lastPositiveMeasuredPowerKw[deviceId] = { kw: measuredPowerKw, ts: now };
    return { measuredPowerKw, observedAtMs };
  }

  private logSourceChange(
    deviceId: string,
    deviceLabel: string,
    source: MeasuredPowerSource | null,
    now: number,
  ): void {
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

// Precedence: a direct watt reading, then the meter, then Homey's live report.
// The reader has already resolved every field to a finite value or absence, so
// presence is the whole test here.
function selectReading(observation: DeviceMeasuredPowerObservation): SelectedReading | null {
  if (observation.measurePowerW !== undefined) {
    return {
      source: 'measure_power',
      watts: observation.measurePowerW,
      observedAtMs: observation.measurePowerObservedAtMs,
    };
  }
  if (observation.meterEnergy !== undefined) {
    return { source: 'meter_power', reading: observation.meterEnergy };
  }
  if (observation.homeyEnergyLiveW !== undefined) {
    return {
      source: 'homey_energy',
      watts: observation.homeyEnergyLiveW,
      observedAtMs: observation.homeyEnergyObservedAtMs,
    };
  }
  return null;
}
