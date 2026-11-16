import type { HomeyDeviceLike } from '../utils/types';

/**
 * Meter integrations whose app keeps its per-phase readings under its own
 * capability names read them under the standard ones (`measure_power.l1`,
 * `measure_current.l1`, ...) that `resolveMeterPhases` recognises. Each
 * integration supplies its own vendor → standard map; this only renames.
 */
export type PhaseNameMap = Readonly<Record<string, string>>;

const declaresVendorPhases = (device: HomeyDeviceLike, names: PhaseNameMap): boolean => (
  Object.entries(names).every(([vendor, standard]) => (
    device.capabilities.includes(vendor) && !device.capabilities.includes(standard)
  ))
);

/**
 * The read with the vendor phase capabilities under their standard names. Only
 * a read that declares every vendor capability and none of the standard ones
 * is renamed: a partial set would read as phases that are not there.
 */
export function projectPhaseNames(device: HomeyDeviceLike, names: PhaseNameMap): HomeyDeviceLike {
  if (!declaresVendorPhases(device, names)) return device;
  const capabilitiesObj = Object.fromEntries(Object.entries(device.capabilitiesObj).map(([capabilityId, entry]) => {
    const standard = names[capabilityId];
    if (standard === undefined || entry === undefined) return [capabilityId, entry];
    return [standard, { ...entry, id: standard }];
  }));
  return {
    ...device,
    capabilities: device.capabilities.map((capabilityId) => names[capabilityId] ?? capabilityId),
    capabilitiesObj,
  };
}

/** A live report's capability as the accepted read names it: standard once that read was renamed. */
export function standardPhaseName(device: HomeyDeviceLike, names: PhaseNameMap, capabilityId: string): string {
  const standard = names[capabilityId];
  if (standard === undefined) return capabilityId;
  const renamed = device.capabilities.includes(standard) && !device.capabilities.includes(capabilityId);
  return renamed ? standard : capabilityId;
}
