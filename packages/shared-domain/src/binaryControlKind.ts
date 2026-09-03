/**
 * Device-KIND classification for binary (on/off) control, shared so the planner
 * (`lib/plan`), observer (`lib/observer`) and executor (`lib/executor`) branch on
 * one predicate instead of each inlining an SDK capability-id presence test.
 * Same vocabulary-containment goal as `isTemperatureControlDevice`
 * (`temperatureDeviceKind.ts`) and `isEvDevice` (`evPlugState.ts`): the
 * discriminant lives here, and consumers ask "is this a binary device?" without
 * naming the field it is read from.
 *
 * It is in shared-domain for reach, not for the UI — observer and executor may
 * not import `lib/plan`, so the plan layer could not host it. Unlike its sibling
 * `isSteppedLoadSnapshot`, it does not yet serve the settings UI: three
 * device-detail sites still inline the test.
 *
 * NOT the same question as `isBinaryControlled` (`binaryControlState.ts`), and
 * the two must not be swapped for each other. This one asks whether the device
 * has a binary control HANDLE — a capability PELS can write. That one asks
 * whether an OBSERVED binary state exists, which is absent both for a non-binary
 * device AND for a binary device before its first observation. A freshly paired
 * switch is binary here and un-controlled there.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

/**
 * A device PELS drives with an on/off command. Keyed on the presence of a
 * resolved binary control capability, which IS the discriminant: a device whose
 * control capability is absent this cycle (e.g. a transient capability drop) is
 * not a binary device this cycle. The plan layer's `isBinaryPlanDevice` narrows
 * on exactly this predicate, so the guard never asserts the `currentOn` the
 * producer omits.
 *
 * Absence answers `false` — a device that is not there has no control handle —
 * which lets a caller holding a possibly-missing snapshot ask the question
 * directly (`!hasBinaryControlCapability(snapshot)`), the same shape
 * `isTemperatureControlDevice` takes. A caller that must go on to READ the
 * snapshot still tests for it separately; this predicate narrows nothing.
 */
export const hasBinaryControlCapability = (
  dev: { binaryControl?: unknown; currentOn?: boolean; binaryControllable?: boolean } | null | undefined,
): boolean => Boolean(dev && (
  dev.binaryControl !== undefined
  || 'currentOn' in dev
  || dev.binaryControllable === true
));
