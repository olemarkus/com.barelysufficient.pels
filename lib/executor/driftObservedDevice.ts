/**
 * What the drift predicate compares planner intent against: the device as the
 * OBSERVER currently reports it, plus the command state the EXECUTOR itself
 * holds. Nothing here has passed through a plan.
 *
 * That provenance is the whole point. Drift used to take a `PlanInputDevice` —
 * the planner's input shape, with observations already folded into it — so the
 * executor never actually saw an observation, only a plan carrying one. The
 * consequence was concrete: `ExecutableObservedDeviceState.observedBinaryState`
 * had to mean two different things depending on which construction path built
 * it, because one path had `currentOn` and no `binaryControl` and the other had
 * the reverse (`TODO.md`, the drift P0).
 *
 * Ownership, per field:
 * - **Observed** (`lib/observer`, live per-device read): availability, the
 *   binary axis, setpoints, measured draw, the device's reported rung, EV plug
 *   state. What the device is doing.
 * - **Commanded** (`lib/executor`, this layer's own stores): whether a binary or
 *   step command is in flight and what it asked for. What PELS asked for.
 * - **Configured** (the ladder): not a reading and not a decision. It rides the
 *   intent, which the executor already receives.
 *
 * The two are kept apart deliberately — see `lib/device/AGENTS.md` on never
 * collapsing `observed` into `commanded`. This type joins them at the point of
 * comparison without merging their meanings.
 */
import { getCurrentDrawKw } from '../observer/observedPower';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveCurrentOn } from '../observer/observedState';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import type {
  EvObservedProbe,
  MeasuredPowerObservedProbe,
  ObservedDeviceState,
  ReportedStepObservedProbe,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';

/**
 * The observer's live entry for one device, as the executor reads it. Widened
 * past the base type with the observed clusters the projection physically
 * carries, because this IS the producer-fed seam that reads them.
 */
export type ObserverDeviceRead = ObservedDeviceState
  & ReportedStepObservedProbe
  & MeasuredPowerObservedProbe
  & EvObservedProbe;

/** In-flight command state, owned by this layer. */
export type DriftCommandRead = {
  binary: { kind: 'pending'; desired: boolean | 'unknown' } | { kind: 'none' };
  step: { kind: 'pending' } | { kind: 'none' };
};

/**
 * The three readers the drift path needs, each pointed at the layer that owns
 * its answer. Injected rather than reached for so the executor keeps no handle
 * on a projection, a store, or a plan.
 */
export type DriftObservationDeps = {
  /** Observer projection, live. `undefined` before a device's first observation. */
  getObservedState: (deviceId: string) => ObserverDeviceRead | undefined;
  /** This layer's pending-command state for the device. */
  getCommandState: (deviceId: string) => DriftCommandRead;
  /**
   * "Leave off until turned on again". A persisted POSTURE rather than a
   * reading — the observer owns the store, and the resolved bit reaches here
   * as a flat boolean so this layer never asks why a device is off.
   */
  isExternalOffHeld: (deviceId: string) => boolean;
};

/**
 * The device's effective rung.
 *
 * `reportedStepId ?? lowest active step` — the same rule the snapshot producer
 * applies (`serializeLegacyStepFieldsFromEvidence`, whose docblock states the
 * effective step is "reportedStepId ?? planning fallback"). It reads the
 * device's report and the configured ladder, and deliberately NOT the commanded
 * target step: what PELS asked for is not evidence of where the device is, and
 * treating it as such is how a command gets mistaken for its own confirmation.
 */
export const resolveObservedSelectedStepId = (
  profile: SteppedLoadProfile | undefined,
  reportedStepId: string | undefined,
): string | undefined => {
  if (!profile) return undefined;
  return getSteppedLoadStep(profile, reportedStepId)?.id
    ?? getSteppedLoadLowestActiveStep(profile)?.id;
};

/**
 * The observed device state the drift comparison reads, assembled from the
 * observer's reading and the configured ladder.
 *
 * `currentOn` is resolved HERE, once, by the observer's own fold
 * (`resolveCurrentOn`): a stepped device parked at its off step reads off even
 * while its binary axis reads on. Resolving at this seam is what lets the
 * comparison downstream read a single settled value instead of re-deciding what
 * an absent `binaryControl` meant.
 */
export const buildDriftObservedSnapshot = (
  observed: ObserverDeviceRead,
  profile: SteppedLoadProfile | undefined,
) => {
  const selectedStepId = resolveObservedSelectedStepId(profile, observed.reportedStepId);
  return {
    ...observed,
    ...(profile !== undefined ? { steppedLoadProfile: profile } : {}),
    ...(selectedStepId !== undefined ? { selectedStepId } : {}),
    currentOn: resolveCurrentOn({
      binaryControl: observed.binaryControl,
      steppedLoadProfile: profile,
      selectedStepId,
    }),
    commandableNow: resolveCommandableNow(observed),
    currentDrawKw: getCurrentDrawKw(observed),
  };
};
