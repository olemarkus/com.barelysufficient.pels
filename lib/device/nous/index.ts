import type { DeviceAdapter } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { projectPhaseNames, standardPhaseName } from '../meterPhaseNames';

// The Nous Smart Energy Monitor D4Z, a three-phase clamp meter
// (`net.franceweb.nous`, driver `smart-energy-monitor-d4z`,
// `notes/native-wiring/nous.md`). The app publishes each phase as
// `measure_power_x`/`_y`/`_z`, with `measure_current_*` and
// `measure_voltage_*` beside them. PELS reads the three phases as L1 to L3
// under the standard names, so the main fuse sees them like any other meter's
// and checks them against the whole-home total.
const D4Z_DRIVER_IDS: ReadonlySet<string> = new Set(['homey:app:net.franceweb.nous:smart-energy-monitor-d4z']);

const PHASE_SUFFIXES = [['x', 'l1'], ['y', 'l2'], ['z', 'l3']] as const;
const FACETS = ['power', 'current', 'voltage'] as const;

/** One map per facet: a meter missing a facet's phases still has its others read. */
const FACET_NAMES: readonly Readonly<Record<string, string>>[] = FACETS.map((facet) => Object.fromEntries(
  PHASE_SUFFIXES.map(([vendor, standard]) => [`measure_${facet}_${vendor}`, `measure_${facet}.${standard}`]),
));

const isD4z = (device: HomeyDeviceLike): boolean => D4Z_DRIVER_IDS.has(device.driverId);

function projectD4zPhases(device: HomeyDeviceLike): HomeyDeviceLike {
  let read = device;
  for (const names of FACET_NAMES) read = projectPhaseNames(read, names);
  return read;
}

function routeD4zReport(device: HomeyDeviceLike, capabilityId: string): string {
  let id = capabilityId;
  for (const names of FACET_NAMES) id = standardPhaseName(device, names, id);
  return id;
}

export const nousEnergyMonitorAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isD4z,
  projectRead: (device) => [projectD4zPhases(device)],
  routeReport: (device, capabilityId) => ({ deviceId: device.id, capabilityId: routeD4zReport(device, capabilityId) }),
};
