/**
 * Observation value accessors used by the boost producer seam
 * (`lib/device/deviceActionProjection.ts`).
 *
 *  - `getTrustedCurrentTemperatureC` returns the temperature when it is a finite
 *    number, else `undefined`. There is NO staleness gate: the plan device carries
 *    no staleness, and temperature boost trusts the latched temperature — a stale
 *    but finite reading still boosts (intended; staleness reporting lives in the
 *    observer, not the boost decision).
 *  - `getTrustedStateOfCharge` returns the SoC only when its own freshness
 *    `status === 'fresh'` and `percent` is finite. That capability-specific
 *    freshness check is the real EV-boost gate and stays.
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
): DeviceStateOfChargeSnapshot | undefined {
  const stateOfCharge = device.stateOfCharge;
  if (!stateOfCharge || stateOfCharge.status !== 'fresh') return undefined;
  if (!isFiniteNumber(stateOfCharge.percent)) return undefined;
  return stateOfCharge;
}
