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
import type { DeviceObjectiveProfileSample } from './types';
import type { ObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';

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
     * The measured quantity this device's objective tracks, with the time it was
     * measured — or `null` when it has no reading. Temperature and SoC resolve to
     * the same shape here (`resolveObjectiveObservedQuantity`); the unit is the
     * only surviving difference, and it is for display.
     *
     * REQUIRED, like `currentDrawKw` above and for the same reason: a caller that
     * forgets it must be a compile error, not a fleet of devices that silently
     * build no samples at all.
     */
    observedQuantity: ObjectiveObservedQuantity | null;
  };

export const OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS = 30 * 60 * 1000;
export const OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS = 5 * 1000;

export function buildObjectiveProfileSample(
  device: ObjectiveSampleDevice,
  nowMs: number,
): DeviceObjectiveProfileSample | null {
  const observed = device.observedQuantity;
  if (!observed) return null;
  // The one question left. NOT a freshness gate on the value — the reading stays
  // usable everywhere else however old it is (a thermostat at setpoint is silent
  // for hours, an idle charger reports its level long before it draws anything).
  // This asks whether the stamp and a power reading taken NOW describe one
  // interval, because the profile bills
  // `previousSample.crediblePowerW × (thisSample.observedAtMs − previous)`
  // (`calculateWindowEnergyKwh`). Pairing an old stamp with current power would
  // bill the whole idle interval at full power. Decision-relative, so it belongs
  // here and not in the producer.
  if (!isUsableSampleObservationTime(observed.observedAtMs, nowMs)) return null;
  return { ...observed, ...resolveCredibleDevicePower(device) };
}

/**
 * Whether an observation's timestamp can be paired with a power reading taken
 * now and still describe one interval.
 *
 * A future-dated stamp is corrupt; one older than the window cannot be joined to
 * current power without misattributing everything in between. Neither is a
 * judgement about the observed VALUE — the producer already resolved that.
 */
function isUsableSampleObservationTime(observedAtMs: number, nowMs: number): boolean {
  return observedAtMs <= nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS
    && nowMs - observedAtMs <= OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS;
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
