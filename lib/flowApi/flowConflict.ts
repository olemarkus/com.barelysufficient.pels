/*
 * Conflict classifier for the native-wiring flow-conflict initiative (PR2).
 *
 * Given the device-capability writes performed by user Flows (PR1's
 * `FlowCapabilityWrites`) and, per device, the capabilities PELS would itself
 * write under native wiring, decide whether a flow conflict exists.
 *
 *   conflict = (capabilities a user Flow writes for the device)
 *              ∩ (capabilities PELS would natively write for the device)
 *
 * This module is intentionally class-agnostic and pure. It does NOT know that
 * a Zaptec writes `charging_button` or that a Hoiax writes `max_power_*` —
 * the caller resolves each device's owned native-write capability set (that
 * resolution lives in the device layer and is wired in at the entry layer in
 * a later PR, keeping `lib/flowApi` free of any cross-peer dependency). Here
 * we only intersect sets.
 *
 * It returns the offending capability ids (not just a boolean) so a later
 * UI surface can name the specific capability a Flow is fighting PELS over.
 */
import type { FlowCapabilityWrites } from './userFlows';

/**
 * A candidate device plus the capabilities PELS would natively write for it.
 * `ownedCapabilities` is a `readonly string[]` rather than `Iterable<string>`
 * on purpose: a bare `string` satisfies `Iterable<string>`, which would make
 * `new Set('target_power')` iterate characters and silently miss a real
 * single-capability conflict. An array forbids that at the type level.
 */
export type DeviceNativeWrite = {
  deviceId: string;
  ownedCapabilities: readonly string[];
};

/** A device that has at least one capability written by both PELS and a Flow. */
export type FlowConflict = {
  deviceId: string;
  conflictingCapabilities: string[];
};

/**
 * Capabilities written by some user Flow that PELS would also natively write
 * for this device. Empty array = no conflict. Order follows `ownedCapabilities`
 * so the result is deterministic for a given owned-set ordering.
 */
export function resolveFlowConflict(
  writes: FlowCapabilityWrites,
  deviceId: string,
  ownedCapabilities: readonly string[],
): string[] {
  const flowWrites = writes.get(deviceId);
  if (!flowWrites || flowWrites.size === 0) return [];

  // `new Set` de-duplicates the owned set while preserving first-seen order,
  // so a repeated owned capability cannot produce a duplicate conflict id.
  return [...new Set(ownedCapabilities)].filter((capabilityId) => flowWrites.has(capabilityId));
}

/**
 * Classify a set of candidate devices, returning one entry per device that
 * has at least one conflicting capability. Devices with no conflict are
 * omitted from the result.
 */
export function classifyFlowConflicts(
  writes: FlowCapabilityWrites,
  devices: readonly DeviceNativeWrite[],
): FlowConflict[] {
  return devices
    .map((device) => ({
      deviceId: device.deviceId,
      conflictingCapabilities: resolveFlowConflict(writes, device.deviceId, device.ownedCapabilities),
    }))
    .filter((conflict) => conflict.conflictingCapabilities.length > 0);
}
