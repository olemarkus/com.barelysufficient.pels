import type {
  DeviceDescriptor,
  ObservedDeviceState,
  StateOfChargeObservedProbe,
  TemperatureObservedProbe,
  ThermalDirection,
} from '../../packages/contracts/src/types';

import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';
import type { DeviceObjectiveProfileSample } from './types';
import { resolveObjectiveProgressDirection } from './types';
import {
  resolveObjectiveObservedQuantity,
  type ObjectiveObservedQuantity,
} from '../../packages/shared-domain/src/objectiveObservedQuantity';

/**
 * Below this, a reading is standby noise rather than a device doing work.
 *
 * Deliberately 5 W — the exact floor `DeviceMeasuredPowerResolver` used to apply
 * before it was removed, so this restores the old boundary at the consumer that
 * needs it instead of at the producer that did not. It is NOT the 50 W
 * actively-drawing threshold used elsewhere: this gate decides whether to trust a
 * reading as the device's draw, and a device genuinely drawing 30 W is doing work.
 */
const MIN_CREDIBLE_DEVICE_POWER_KW = 0.005;

// Observed truth (temperature / SoC) plus the producer-resolved draw and the few
// descriptor fields the kind predicates need — NOT the full producer-input
// `TargetDeviceSnapshot`. Objectives is a downstream consumer; it depends on the
// decomposed snapshot halves, never the raw producer snapshot. The observed
// (`TemperatureObservedProbe` / `StateOfChargeObservedProbe`) widenings carry the
// cluster fields the base type omits (this is a producer-fed funnel);
// `hasObservedTemperature` / `hasObservedStateOfCharge` narrow them.
//
// The POWER axis is deliberately not one of them. The raw `measuredPowerKw` does
// not travel past the producer, so the caller
// (`setup/powerSamplePipeline.ts` → `withHeadroomCurrentOn`) resolves it and this
// contract takes the resolved value. REQUIRED, so a caller that forgets is a
// compile error rather than a fleet of devices silently learning at 0 W.
export type ObjectiveSampleDevice = ObservedDeviceState
  & TemperatureObservedProbe
  & StateOfChargeObservedProbe
  & Pick<DeviceDescriptor, 'isEvCharger' | 'deviceType'>
  & {
    currentDrawKw: number;
    thermalDirection: ThermalDirection;
    /**
     * The measured quantity this device's objective tracks. Temperature and SoC
     * resolve to the same shape here (`resolveObjectiveObservedQuantity`); the
     * unit is the only surviving difference, and it is for display. No
     * observation time travels with it: freshness and trust are settled at the
     * observer, and the profile works on its caller's clock.
     *
     * REQUIRED and non-null, like `currentDrawKw` above: a device with nothing to
     * sample is not passed at all, so this contract means "a device with a
     * reading" and no consumer models an absence that the seam already resolved.
     */
    observedQuantity: ObjectiveObservedQuantity;
  };

export type ObjectiveSampleSourceDevice = Omit<ObjectiveSampleDevice, 'thermalDirection' | 'observedQuantity'>;

/** Resolve observer-owned direction and the device's measured quantity before profiling. */
export const resolveObjectiveSampleDevices = (
  devices: readonly ObjectiveSampleSourceDevice[],
  getThermalDirection: (deviceId: string) => ThermalDirection,
): ObjectiveSampleDevice[] => devices.flatMap((device) => {
  const observedQuantity = resolveObjectiveObservedQuantity(device);
  return observedQuantity === null
    ? []
    : [{
      ...device,
      observedQuantity,
      thermalDirection: getThermalDirection(device.id),
    }];
});

// A sample is the device's quantity and draw as they stand at `nowMs`, the
// caller's clock. Both are levels that hold until they change, so a device that
// stopped reporting is still at its last value, and the profile bills each
// sample's power until the next sample (`calculateWindowEnergyKwh`).
export function buildObjectiveProfileSample(
  device: ObjectiveSampleDevice,
  nowMs: number,
): DeviceObjectiveProfileSample {
  return {
    observedAtMs: nowMs,
    value: device.observedQuantity.value,
    progressDirection: resolveObjectiveProgressDirection({
      objectiveKind: isEvDevice(device) ? 'ev_soc' : 'temperature',
      thermalDirection: device.thermalDirection,
    }),
    ...resolveCredibleDevicePower(device),
  };
}

function resolveCredibleDevicePower(
  device: ObjectiveSampleDevice,
): Pick<DeviceObjectiveProfileSample, 'crediblePowerW'> {
  // Only a measured reading is evidence of what the device drew. A step's
  // configured power is what it is expected to draw, not what it drew, so it is
  // never credited, for any device (owner ruling 2026-09-27): an Easee in its
  // ~5 min hold after a resume, or a water heater whose thermostat has cut out,
  // reads on at a step and draws nothing, and crediting the step billed that to
  // the learned rate.
  //
  // `currentDrawKw` is the producer's resolved answer: finite, non-negative, and
  // `0` for a device with no meter. No reading and a measured 0 W both credit
  // nothing, so this consumer need not tell them apart.
  //
  // The threshold is `MIN_CREDIBLE_DEVICE_POWER_KW`, not a bare `> 0`: a standby
  // trickle reaches this function, and billing a coast window at 3 W as measured
  // poisons the learned kWh-per-unit rate and defeats the `powerW <= 0`
  // coast-window protection in `energyAccumulator`/`profiles`.
  if (device.currentDrawKw <= MIN_CREDIBLE_DEVICE_POWER_KW) return {};
  return { crediblePowerW: Math.round(device.currentDrawKw * 1000) };
}
