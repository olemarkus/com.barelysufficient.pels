/**
 * The one owner of what a mode says about the devices in a home: the order it
 * puts them in, and the setpoint it holds each temperature device at.
 *
 * Two questions, because callers genuinely ask two:
 *
 * - `rankModeDevices` — the mode's ORDER over a set of devices. Needs nothing
 *   but their ids and the stored ranks.
 * - `resolveModeTargets` — the mode's SETPOINT for the devices that have one.
 *   Needs each device's own setpoint, and whether PELS currently owes it one.
 *
 * Neither answer is ever partial. Every device handed to `rankModeDevices` comes
 * back with a unique, gap-free rank; every device handed to `resolveModeTargets`
 * comes back with a target. "The temperature if applicable" is expressed by WHICH
 * devices reach the second question — a device with no `target_temperature` axis
 * simply is not one of them — rather than by a null answer every consumer has to
 * branch on. Applicability is already resolved upstream (`isTemperaturePlanDevice`,
 * and the per-device temperature-control flag, which strips the target axis at
 * `projectEffectiveControlDevice`); this module does not re-derive it.
 *
 * Why one module rather than a convention: the gap-filling used to be re-derived
 * at every call site, and the copies disagreed. `resolveDevicePriority` answered
 * `100` for anything unranked, so two unranked devices tied — while
 * `rankActiveDevicePriorities`, one layer up in the same repo, resolved a strict
 * order for the same devices. Temperature was worse: nothing filled it on read at
 * all, so a device with no stored target was planned, shed, and left with no
 * setpoint to be restored to.
 *
 * Browser-safe and free of capability metadata: it takes numbers and returns
 * numbers. Normalizing a setpoint to a device's min/max/step is the binding
 * layer's job, done to the values it passes IN, so what comes back out is
 * already in the device's own terms.
 */
import { rankActiveDevicePriorities } from './modePriorities';

const finiteOrUndefined = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

/**
 * The mode's order over these devices: unique, gap-free `1..N`, lower wins.
 *
 * `priorityFor` is the STORED rank, untrusted — absent, duplicated and non-finite
 * entries all resolve into the strict order rather than out of it, which is what
 * makes a tie unrepresentable in the answer.
 */
export const rankModeDevices = (
  deviceIds: readonly string[],
  priorityFor: (deviceId: string) => unknown,
): Readonly<Record<string, number>> => rankActiveDevicePriorities(deviceIds, priorityFor);

/**
 * A device that HAS a setpoint, and the setpoint PELS holds it at when the mode
 * has none stored.
 *
 * Only such devices reach `resolveModeTargets`, so there is no "this one has no
 * setpoint" member to model: `heldSetpointC` is a plain number because the
 * caller has already established the device has one.
 *
 * The caller resolves it, because deciding it is somebody else's rule: normally
 * the device's own live setpoint, but the PRE-SHED ANCHOR while PELS has the
 * device parked at a shed floor, where the live value IS the shed value
 * (`resolveAnchoredSetpoint`, `lib/plan/preShedAnchor.ts`). Taking the answer
 * rather than the ingredients keeps that rule with its owner instead of
 * restating it here — which is how it ended up spelled two different ways at the
 * two call sites.
 */
export type ModeTargetDevice = {
  id: string;
  heldSetpointC: number;
};

/**
 * Where a resolved target came from.
 *
 * `filled` is the answer for a device whose mode entry has not been written down
 * yet. It carries the same `targetC` a `stored` answer would, so consumers that
 * only want the number never branch; the persist pass is the one that cares,
 * because `filled` is exactly what it writes down.
 */
export type ResolvedModeTarget =
  | { kind: 'stored'; targetC: number }
  | { kind: 'filled'; targetC: number };

export type ResolvedModeTargets = {
  /** One entry per device asked about. */
  targetByDeviceId: Readonly<Record<string, ResolvedModeTarget>>;
  /**
   * The subset this resolution had to fill because nothing was stored.
   *
   * The resolver stays a pure read — it never writes — but PELS owns a managed
   * thermostat's setpoint, and an owned setpoint that exists only for the
   * lifetime of one call is not owned at all: the next restart would resolve it
   * from wherever the device had drifted to. So the caller that has a settings
   * seam persists these once, and every later resolution answers `stored`.
   * Empty whenever everything was already stored.
   */
  unstoredTargetsByDeviceId: Readonly<Record<string, number>>;
};

/**
 * The mode's setpoint for each of these devices.
 *
 * The stored per-mode target wins — the owner's own answer, and the only one
 * that survives a restart on its own. Failing that, the setpoint the caller says
 * PELS is holding the device at.
 *
 * `targetCFor` is the stored value, untrusted: anything non-finite reads as
 * absent, so a corrupt entry is filled like a missing one rather than flowing
 * into a comparison.
 */
export const resolveModeTargets = (params: {
  targetCFor: (deviceId: string) => unknown;
  devices: readonly ModeTargetDevice[];
}): ResolvedModeTargets => {
  const { targetCFor, devices } = params;
  const unstoredTargetsByDeviceId: Record<string, number> = {};
  const targetByDeviceId: Record<string, ResolvedModeTarget> = {};
  for (const device of devices) {
    const storedTargetC = finiteOrUndefined(targetCFor(device.id));
    if (storedTargetC !== undefined) {
      targetByDeviceId[device.id] = { kind: 'stored', targetC: storedTargetC };
      continue;
    }
    targetByDeviceId[device.id] = { kind: 'filled', targetC: device.heldSetpointC };
    unstoredTargetsByDeviceId[device.id] = device.heldSetpointC;
  }
  return { targetByDeviceId, unstoredTargetsByDeviceId };
};
