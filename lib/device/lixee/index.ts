import type { DeviceAdapter } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { projectPhaseNames, standardPhaseName } from '../meterPhaseNames';
import { resolveMeterPhases } from '../meterPhases';

// The LiXee ZLinky_TIC reads a French Linky meter (`com.lixee`, driver
// `zlinky_tic`, `notes/native-wiring/lixee.md`). On a three-phase supply the
// app publishes each phase's apparent power in `phase_1_apparent_power_capability`
// to `phase_3_apparent_power_capability`, beside the whole-home `measure_power`.
// PELS reads them as `measure_power.l1` to `measure_power.l3`, so the main fuse
// sees the phases like any other meter's and checks them against the total.
const ZLINKY_DRIVER_IDS: ReadonlySet<string> = new Set(['homey:app:com.lixee:zlinky_tic']);

/** Vendor capability → the standard phase capability PELS reads it as. */
const STANDARD_BY_VENDOR: Readonly<Record<string, string>> = {
  phase_1_apparent_power_capability: 'measure_power.l1',
  phase_2_apparent_power_capability: 'measure_power.l2',
  phase_3_apparent_power_capability: 'measure_power.l3',
};

const isZlinky = (device: HomeyDeviceLike): boolean => ZLINKY_DRIVER_IDS.has(device.driverId);
const APPARENT_PHASES = new Set(Object.values(STANDARD_BY_VENDOR));

export const lixeeZlinkyAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isZlinky,
  projectRead: (device) => [projectPhaseNames(device, STANDARD_BY_VENDOR)],
  meterPhases(device, ownerChoice) {
    const view = projectPhaseNames(device, STANDARD_BY_VENDOR);
    const read = resolveMeterPhases(view, ownerChoice);
    if (view === device || read.state !== 'read' || read.powerW === undefined) return read;
    if (ownerChoice !== null) {
      const { L1, L2, L3 } = ownerChoice;
      if (![L1, L2, L3].some((id) => APPARENT_PHASES.has(id))) return read;
    }
    const { powerW, ...remaining } = read;
    return { ...remaining, apparentPowerVA: powerW };
  },
  routeReport: (device, capabilityId) => ({
    deviceId: device.id, capabilityId: standardPhaseName(device, STANDARD_BY_VENDOR, capabilityId),
  }),
};
