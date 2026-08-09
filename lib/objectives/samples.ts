import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { isBinaryObservedOff } from '../../packages/shared-domain/src/binaryControlState';
import {
  hasObservedReportedStep,
  isSteppedLoadSnapshot,
} from '../../packages/shared-domain/src/steppedLoadObservedState';
import type {
  DeviceDescriptor,
  MeasuredPowerObservedProbe,
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

// Observed truth (temperature / SoC / measured power / reported step) plus the
// few descriptor fields the kind predicates need — NOT the full producer-input
// `TargetDeviceSnapshot`. Objectives is a downstream consumer; it depends on the
// decomposed snapshot halves, never the raw producer snapshot. The observed
// (`TemperatureObservedProbe` / `StateOfChargeObservedProbe` /
// `MeasuredPowerObservedProbe` / `ReportedStepObservedProbe`) and stepped-descriptor
// (`SteppedLoadDescriptorProbe`) widenings carry the cluster fields the base type
// omits (this is a producer-fed funnel); `hasObservedTemperature` /
// `hasObservedStateOfCharge` / `hasObservedMeasuredPower` / `hasObservedReportedStep`
// / `isSteppedLoadSnapshot` narrow them.
export type ObjectiveSampleDevice = ObservedDeviceState
  & TemperatureObservedProbe
  & StateOfChargeObservedProbe
  & MeasuredPowerObservedProbe
  & SteppedLoadDescriptorProbe
  & ReportedStepObservedProbe
  & Pick<DeviceDescriptor, 'deviceClass' | 'deviceType' | 'controlCapabilityId'>;

export const OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS = 30 * 60 * 1000;
export const OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS = 5 * 1000;

export function buildObjectiveProfileSample(
  device: ObjectiveSampleDevice,
  nowMs: number,
): DeviceObjectiveProfileSample | null {
  if (isFreshTemperatureDevice(device, nowMs)) {
    return {
      observedAtMs: device.lastFreshDataMs,
      value: Math.round(device.currentTemperature * 10) / 10,
      unit: 'degree_c',
      ...resolveCredibleDevicePower(device),
    };
  }

  if (isEvDevice(device) && hasObservedStateOfCharge(device)) {
    // `level` is the whole gate. No age check and no `Number.isFinite` re-check:
    // the producer stands behind the level or reports none, and a battery level
    // does not decay — so the 30-minute observation window that used to sit here
    // was a second, unrelated cutoff over a reading the producer had already
    // resolved. `OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS` still gates the
    // temperature branch, whose sensor reports continuously.
    const { level } = device.stateOfCharge;
    if (level.kind !== 'known') return null;
    const observedAtMs = device.stateOfCharge.observedAtMs ?? device.lastFreshDataMs;
    if (typeof observedAtMs !== 'number' || !Number.isFinite(observedAtMs)) return null;
    // Future-dated observations are still refused. That is not an age gate: a
    // timestamp ahead of now is corrupt, and a sample carries its own
    // `observedAtMs` into the profile's interval arithmetic.
    if (observedAtMs > nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS) return null;
    return {
      observedAtMs,
      value: level.percent,
      unit: 'percent',
      ...resolveCredibleDevicePower(device),
    };
  }

  return null;
}

function isFreshTemperatureDevice(
  device: ObjectiveSampleDevice,
  nowMs: number,
): device is ObjectiveSampleDevice & { currentTemperature: number; lastFreshDataMs: number } {
  // `hasObservedTemperature` proves `currentTemperature` is a finite `number`
  // (producer invariant), so no `typeof`/`Number.isFinite` re-check here — the
  // kind question is asked separately via `isTemperatureControlDevice`.
  return isTemperatureControlDevice(device)
    && hasObservedTemperature(device)
    && typeof device.lastFreshDataMs === 'number'
    && Number.isFinite(device.lastFreshDataMs)
    && isFreshObservationTime(device.lastFreshDataMs, nowMs);
}

function isFreshObservationTime(observedAtMs: number, nowMs: number): boolean {
  return observedAtMs <= nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS
    && nowMs - observedAtMs <= OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS;
}

function resolveCredibleDevicePower(
  device: ObjectiveSampleDevice,
): Pick<DeviceObjectiveProfileSample, 'crediblePowerW' | 'powerSource'> {
  // `hasObservedMeasuredPower` proves `measuredPowerKw` is a finite `number`
  // (producer invariant — the write seams store only `Number.isFinite` values),
  // so no `typeof`/`Number.isFinite` re-check here.
  //
  // The threshold is `MIN_CREDIBLE_DEVICE_POWER_KW`, not a bare `> 0`. The
  // measured-power resolver used to drop any reading at or below 5 W; that floor
  // was removed (it made "drawing 3 W" indistinguishable from "has no meter",
  // which is what licensed a rated-power substitution), so a standby trickle now
  // reaches this function. Billing a coast window at 3 W as `powerSource:
  // 'measured'` poisons the learned kWh-per-unit rate and defeats the `powerW <= 0`
  // coast-window protection described below. Credibility is this consumer's
  // question, so it is asked here rather than back at the producer.
  if (hasObservedMeasuredPower(device) && device.measuredPowerKw > MIN_CREDIBLE_DEVICE_POWER_KW) {
    return {
      crediblePowerW: Math.round(device.measuredPowerKw * 1000),
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
