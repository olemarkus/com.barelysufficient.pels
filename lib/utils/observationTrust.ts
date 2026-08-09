/**
 * Observation value accessors used by the boost producer seam
 * (`lib/device/deviceActionProjection.ts`).
 *
 *  - `getTrustedCurrentTemperatureC` returns the temperature when it is a finite
 *    number, else `undefined`. There is NO staleness gate: the plan device carries
 *    no staleness, and temperature boost trusts the latched temperature — a stale
 *    but finite reading still boosts (intended; staleness reporting lives in the
 *    observer, not the boost decision).
 *  - `getTrustedStateOfCharge` returns the level the producer stands behind, or
 *    `undefined` when it stands behind none. It does NOT gate on freshness —
 *    there is none to gate on. A battery level is reported on change and can
 *    only change while a car is attached, so the producer answers usability
 *    outright on `stateOfCharge.level` (`lib/device/transport/stateOfCharge.ts`)
 *    and this reads that answer.
 *
 * Lives in `lib/utils/` so both `lib/observer/` and `lib/device/` can import a
 * single source (the latter cannot import `lib/observer/`).
 */
import { isFiniteNumber } from './appTypeGuards';
import type { DeviceStateOfChargeSnapshot } from '../../packages/contracts/src/types';

type TrustedTemperatureInput = {
  currentTemperature?: number;
};

type TrustedStateOfChargeInput = {
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

export function getTrustedCurrentTemperatureC(
  device: TrustedTemperatureInput,
): number | undefined {
  const temperature = device.currentTemperature;
  if (!isFiniteNumber(temperature)) return undefined;
  return temperature;
}

export function getTrustedStateOfCharge(
  device: TrustedStateOfChargeInput,
): number | undefined {
  // No `Number.isFinite` re-check: `normalizeStateOfChargePercent` guarantees a
  // finite percentage at the producer, and `level` already answers whether there
  // is one at all (producer invariant).
  const level = device.stateOfCharge?.level;
  return level?.kind === 'known' ? level.percent : undefined;
}
