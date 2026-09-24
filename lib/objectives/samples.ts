import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { isBinaryObservedOff } from '../../packages/shared-domain/src/binaryControlState';
import {
  hasObservedReportedStep,
  isSteppedLoadSnapshot,
} from '../../packages/shared-domain/src/steppedLoadObservedState';
import type {
  DeviceDescriptor,
  ObservedDeviceState,
  ReportedStepObservedProbe,
  StateOfChargeObservedProbe,
  SteppedLoadDescriptorProbe,
  TemperatureObservedProbe,
} from '../../packages/contracts/src/types';

import type { DeviceObjectiveProfileSample } from './types';
import type { ObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';

/**
 * Below this, a reading is standby noise rather than a device doing work.
 *
 * Deliberately 5 W — the exact floor `DeviceMeasuredPowerResolver` used to apply
 * before it was removed, so this restores the old boundary at the consumer that
 * needs it instead of at the producer that did not. It is NOT the 50 W
 * actively-drawing threshold used elsewhere: this gate decides whether to trust a
 * reading as `powerSource: 'measured'`, and a device genuinely drawing 30 W is
 * doing work. Setting it at 50 W would push that device onto its step NAMEPLATE
 * (`reported_step_planning` below) — substituting a rated figure for a real meter
 * reading, which is the defect this whole change removes.
 */
const MIN_CREDIBLE_DEVICE_POWER_KW = 0.005;

// Observed truth (temperature / SoC / reported step) plus the producer-resolved
// draw and the few descriptor fields the kind predicates need — NOT the full
// producer-input `TargetDeviceSnapshot`. Objectives is a downstream consumer; it
// depends on the decomposed snapshot halves, never the raw producer snapshot.
// The observed (`TemperatureObservedProbe` / `StateOfChargeObservedProbe` /
// `ReportedStepObservedProbe`) and stepped-descriptor
// (`SteppedLoadDescriptorProbe`) widenings carry the cluster fields the base type
// omits (this is a producer-fed funnel); `hasObservedTemperature` /
// `hasObservedStateOfCharge` / `hasObservedReportedStep` / `isSteppedLoadSnapshot`
// narrow them.
//
// The POWER axis is deliberately not one of them. The raw `measuredPowerKw` does
// not travel past the producer, so the caller
// (`setup/powerSamplePipeline.ts` → `withHeadroomCurrentOn`) resolves it and this
// contract takes the resolved value. REQUIRED, so a caller that forgets is a
// compile error rather than a fleet of devices silently learning at 0 W.
export type ObjectiveSampleDevice = ObservedDeviceState
  & TemperatureObservedProbe
  & StateOfChargeObservedProbe
  & SteppedLoadDescriptorProbe
  & ReportedStepObservedProbe
  & Pick<DeviceDescriptor, 'deviceClass' | 'deviceType'>
  & {
    currentDrawKw: number;
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
    ...resolveCredibleDevicePower(device),
  };
}

function resolveCredibleDevicePower(
  device: ObjectiveSampleDevice,
): Pick<DeviceObjectiveProfileSample, 'crediblePowerW' | 'powerSource'> {
  // `currentDrawKw` is the producer's resolved answer: finite, non-negative, and
  // `0` for a device with no meter — so no presence guard and no
  // `typeof`/`Number.isFinite` re-check. It reads the same number the previous
  // `hasObservedMeasuredPower(device) && device.measuredPowerKw > …` pair did:
  // absence resolves to `0`, which fails a positive threshold either way.
  //
  // The threshold is `MIN_CREDIBLE_DEVICE_POWER_KW`, not a bare `> 0`. The
  // measured-power resolver used to drop any reading at or below 5 W; that floor
  // was removed (it made "drawing 3 W" indistinguishable from "has no meter",
  // which is what licensed a rated-power substitution), so a standby trickle now
  // reaches this function. Billing a coast window at 3 W as `powerSource:
  // 'measured'` poisons the learned kWh-per-unit rate and defeats the `powerW <= 0`
  // coast-window protection described below. Credibility is this consumer's
  // question, so it is asked here rather than back at the producer.
  if (device.currentDrawKw > MIN_CREDIBLE_DEVICE_POWER_KW) {
    return {
      crediblePowerW: Math.round(device.currentDrawKw * 1000),
      powerSource: 'measured',
    };
  }

  if (!isSteppedLoadSnapshot(device)) return {};
  // A device whose binary axis reads off draws nothing, whatever step it is parked
  // at. Since 2026-07-25 a non-off step report IS admitted while off (devices can
  // change their own step while paused), so the step axis alone no longer implies
  // draw — without this gate a paused stepper would bill its coast window at the
  // step's nameplate and poison the learned rate, defeating the `powerW <= 0`
  // coast-window protection in `energyAccumulator`/`profiles`.
  if (isBinaryObservedOff(device)) return {};
  const profile = device.steppedLoadProfile;
  const reportedStepId = hasObservedReportedStep(device) ? device.reportedStepId : undefined;
  const reportedStep = getSteppedLoadStep(profile, reportedStepId);
  if (reportedStep && !isSteppedLoadOffStep(profile, reportedStep.id) && reportedStep.planningPowerW > 0) {
    return {
      crediblePowerW: Math.round(reportedStep.planningPowerW),
      powerSource: 'reported_step_planning',
    };
  }

  return {};
}
