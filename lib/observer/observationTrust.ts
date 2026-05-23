/**
 * Observer-owned trust gates. Each accessor resolves a single question that
 * plan-side consumers used to answer by branching on `observationStale`. The
 * producer (this module) hides freshness policy; consumers receive flat
 * values they can use without re-checking provenance.
 *
 * Three shapes:
 *
 *  - **Trusted scalar accessors** (`getTrustedCurrentTemperatureC`,
 *    `getTrustedStateOfCharge`) return the value when it is safe to act on,
 *    else `undefined`. Stale observations and capability-specific freshness
 *    signals (e.g. SoC `status !== 'fresh'`) collapse to `undefined`.
 *  - **Generic trust gate** (`isDeviceObservationTrusted`) — for consumers
 *    that need a yes/no "is this observation safe to act on" before reading
 *    other signals (recovery confirmability in `plan/restore/coordination`,
 *    diagnostics evidence eligibility in `planDiagnostics` and the deferred
 *    objectives bridge).
 */
import { isFiniteNumber } from '../utils/appTypeGuards';
import type { DeviceStateOfChargeSnapshot } from '../../packages/contracts/src/types';

type ObservationTrustInput = {
  observationStale?: boolean;
};

type TrustedTemperatureInput = ObservationTrustInput & {
  currentTemperature?: number;
};

type TrustedStateOfChargeInput = ObservationTrustInput & {
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

export function isDeviceObservationTrusted(device: ObservationTrustInput): boolean {
  return device.observationStale !== true;
}

export function getTrustedCurrentTemperatureC(
  device: TrustedTemperatureInput,
): number | undefined {
  if (!isDeviceObservationTrusted(device)) return undefined;
  const temperature = device.currentTemperature;
  if (!isFiniteNumber(temperature)) return undefined;
  return temperature;
}

export function getTrustedStateOfCharge(
  device: TrustedStateOfChargeInput,
): DeviceStateOfChargeSnapshot | undefined {
  if (!isDeviceObservationTrusted(device)) return undefined;
  const stateOfCharge = device.stateOfCharge;
  if (!stateOfCharge || stateOfCharge.status !== 'fresh') return undefined;
  if (!isFiniteNumber(stateOfCharge.percent)) return undefined;
  return stateOfCharge;
}

