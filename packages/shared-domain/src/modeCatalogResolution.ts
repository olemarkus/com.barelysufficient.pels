/**
 * Resolves each temperature device's mode target before it reaches a consumer.
 * Priority orders belong to settings/modePriorities; this module owns setpoints.
 * Browser and runtime callers provide normalized held setpoints, so every answer
 * is already in the device's own temperature terms.
 */
const finiteOrUndefined = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

/**
 * A device that HAS a setpoint, and the setpoint PELS holds it at when the mode
 * has none stored.
 *
 * Only such devices reach `resolveModeTargets`, so there is no "this one has no
 * setpoint" member to model: `heldSetpointC` is a plain number because the
 * caller has already established the device has one.
 *
 * The caller resolves it, because deciding it is somebody else's rule: the
 * device's own live setpoint, normalized to its target capability's bounds
 * (`buildModeTargetProbe`, `setup/appDeviceSupport.ts`). There is exactly one
 * source and no second lane — PELS keeps no memory of what a device was set to
 * before it was lowered, and a persisted pre-shed anchor that recorded one was
 * built and then removed for that reason (`notes/temperature-ownership.md`).
 * Taking the answer rather than the ingredients keeps that rule with its owner
 * instead of restating it here — which is how it ended up spelled two different
 * ways at the two call sites.
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
