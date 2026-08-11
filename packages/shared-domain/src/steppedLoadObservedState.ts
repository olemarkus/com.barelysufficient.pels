import type {
  ReportedStepObservedFields,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorFields,
  SteppedLoadDescriptorProbe,
} from '../../contracts/src/types';

/**
 * Type guard: the snapshot is a stepped load. The snapshot-shaped twin of
 * `lib/plan`'s `isSteppedLoadDevice` (which narrows plan-layer devices) — a
 * consumer must test/narrow through this before reading `steppedLoadProfile` /
 * `targetPowerConfig`; the fields are omitted from the base snapshot types, so
 * this guard (or an already-narrowed value) is the only typed way to reach them.
 * On the narrowed shape `steppedLoadProfile` is a guaranteed
 * `SteppedLoadProfile` (never `undefined`), so consumers read it (and the
 * optional `targetPowerConfig`) without re-handling the absent case.
 *
 * The presence IS the kind, and the predicate says only that. `SteppedLoadProfile`
 * has one `model`, the single literal `'stepped_load'`, so on an already-typed
 * value comparing it asserts nothing the presence of the field did not already
 * say — a presence check wearing a costume. The place that comparison does real
 * work is `normalizeSteppedLoadProfile` (`packages/contracts/src/deviceControlProfiles.ts`),
 * which takes `value: unknown` at the parse boundary; that is where a future
 * second profile model would be discriminated, and the storage slot is already
 * single-typed anyway (`DeviceControlProfile` IS `SteppedLoadProfile`, and
 * `DeviceControlProfiles` is a per-device record of those).
 *
 * This is a type guard, not a validator. Whether the ladder is USABLE is the
 * producer's question and is already answered there — `asSteppedLoadProfile`
 * refuses a profile with no rung above zero, so a profile that reaches a consumer
 * has one. Do not re-ask it here: a "stepped but no usable ladder" value
 * downstream is a producer bug to fix at the producer, and a second opinion in
 * the guard would only hide it.
 *
 * Generic over the carrier so it narrows `TargetDeviceSnapshot`,
 * `DecoratedDeviceSnapshot`, and probe-widened owner shapes alike. Lives in
 * shared-domain (browser-safe) so the settings UI and widgets narrow the same way
 * the runtime does, and so `lib/plan`'s `isSteppedLoadDevice` and
 * `withSteppedDiscriminant` have one definition to delegate to.
 */
export const isSteppedLoadSnapshot = <T extends SteppedLoadDescriptorProbe>(
  snapshot: T,
): snapshot is T & SteppedLoadDescriptorFields => (
  snapshot.steppedLoadProfile !== undefined
);

/**
 * Type guard: the snapshot carries an observed `reportedStepId`, a guaranteed
 * `string` on the narrowed shape. PRESENCE-ONLY, like the other observed-state
 * guards: a non-stepped device never reports a step, and a stepped device
 * carries it only once a native/flow report lands, so a consumer narrows on
 * presence rather than device kind. Browser-safe and generic over the carrier.
 */
export const hasObservedReportedStep = <T extends ReportedStepObservedProbe>(
  snapshot: T,
): snapshot is T & ReportedStepObservedFields => (
  snapshot.reportedStepId != null
);
