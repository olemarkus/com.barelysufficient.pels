import type {
  ReportedStepObservedFields,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorFields,
  SteppedLoadDescriptorProbe,
} from '../../contracts/src/types';

/**
 * A device snapshot that is a stepped load. On this narrowed shape
 * `steppedLoadProfile` is a guaranteed `SteppedLoadProfile` (never `undefined`),
 * so consumers read it (and the optional `targetPowerConfig`) without re-handling
 * the absent case.
 */
export type SteppedLoadSnapshot<T> = T & SteppedLoadDescriptorFields;

/**
 * Type guard: the snapshot is a stepped load. The snapshot-shaped twin of
 * `lib/plan`'s `isSteppedLoadDevice` (which narrows plan-layer devices) — a
 * consumer must test/narrow through this before reading `steppedLoadProfile` /
 * `targetPowerConfig`; the fields are omitted from the base snapshot types, so
 * this guard (or an already-narrowed value) is the only typed way to reach them.
 *
 * `steppedLoadProfile.model` is always `'stepped_load'`, so presence is the kind:
 * the `=== 'stepped_load'` check matches `isSteppedLoadDevice` exactly and stays
 * robust to a future second profile model. Generic over the carrier so it narrows
 * `TargetDeviceSnapshot`, `DecoratedDeviceSnapshot`, and probe-widened owner shapes
 * alike. Lives in shared-domain (browser-safe) so the settings UI and widgets
 * narrow the same way the runtime does.
 */
export const isSteppedLoadSnapshot = <T extends SteppedLoadDescriptorProbe>(
  snapshot: T,
): snapshot is T & SteppedLoadDescriptorFields => (
  snapshot.steppedLoadProfile?.model === 'stepped_load'
);

/**
 * A device snapshot that has reported a step. On this narrowed shape
 * `reportedStepId` is a guaranteed `string`.
 */
export type ReportedStepSnapshot<T> = T & ReportedStepObservedFields;

/**
 * Type guard: the snapshot carries an observed `reportedStepId`. PRESENCE-ONLY,
 * like the other observed-state guards: a non-stepped device never reports a step,
 * and a stepped device carries it only once a native/flow report lands, so a
 * consumer narrows on presence rather than device kind. Browser-safe and generic
 * over the carrier.
 */
export const hasObservedReportedStep = <T extends ReportedStepObservedProbe>(
  snapshot: T,
): snapshot is T & ReportedStepObservedFields => (
  snapshot.reportedStepId != null
);
