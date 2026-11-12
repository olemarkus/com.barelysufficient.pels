import type { CapabilityRoute, DeviceAdapter, HomeBatteryBinding, HomeBatteryModeBinding } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { isDeviceOfAppDriver, STANDARD_HOME_BATTERY_BINDING } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

// HomeWizard Plug-In Batteries on the HomeWizard app (`com.homewizard` 3.20.3,
// `notes/battery-vendor-bindings.md` § "HomeWizard Plug-In Battery"). The
// batteries take no power setting: the P1 meter (`energy_v2`) holds the
// group's one mode, `battery_group_charge_mode`, and its power, average charge
// level and charge and discharge limits. PELS reads the group as one battery
// under `<P1 id>~battery_group`, drives it by that mode, and leaves the P1
// itself, under its own id, the meter it is. The batteries' own devices are
// dropped: their power and level are the group's again, and their app accepts
// no control of them.

const APP_ID = 'com.homewizard';
const P1_DRIVER = 'energy_v2';
const BATTERY_DRIVER = 'plugin_battery';
const GROUP_SUFFIX = '~battery_group';

const MODE = 'battery_group_charge_mode';
const GROUP_POWER = 'measure_power.battery_group_power_w';
const GROUP_LEVEL = 'battery_group_average_soc';
const MAX_CHARGE = 'measure_power.battery_group_max_consumption_w';
const MAX_DISCHARGE = 'measure_power.battery_group_max_production_w';
const GROUP_CAPACITY = 'battery_group_total_capacity_kwh';

/** The group's own reads, by the names the battery view gives them. */
const GROUP_RENAMES: Readonly<Record<string, string>> = {
  [GROUP_POWER]: 'measure_power',
  [GROUP_LEVEL]: 'measure_battery',
  [MODE]: MODE,
  [MAX_CHARGE]: MAX_CHARGE,
  [MAX_DISCHARGE]: MAX_DISCHARGE,
  [GROUP_CAPACITY]: GROUP_CAPACITY,
};

const isP1 = (device: HomeyDeviceLike): boolean => isDeviceOfAppDriver(device, APP_ID, P1_DRIVER);
const isPlugInBattery = (device: HomeyDeviceLike): boolean => isDeviceOfAppDriver(device, APP_ID, BATTERY_DRIVER);
const isGroupView = (device: HomeyDeviceLike): boolean => device.id.endsWith(GROUP_SUFFIX);

/** A P1 with a battery group: the app adds these only once it reports a battery. */
const holdsBatteryGroup = (device: HomeyDeviceLike): boolean => (
  [MODE, GROUP_POWER, GROUP_LEVEL].every((capabilityId) => device.capabilities.includes(capabilityId))
);

function groupView(device: HomeyDeviceLike): HomeyDeviceLike {
  const capabilities = device.capabilities.flatMap((capabilityId) => {
    const renamed = GROUP_RENAMES[capabilityId];
    return renamed === undefined ? [] : [renamed];
  });
  const capabilitiesObj = Object.fromEntries(Object.entries(device.capabilitiesObj).flatMap(([capabilityId, entry]) => {
    const renamed = GROUP_RENAMES[capabilityId];
    return renamed === undefined ? [] : [[renamed, entry === undefined ? entry : { ...entry, id: renamed }]];
  }));
  return {
    ...device,
    id: `${device.id}${GROUP_SUFFIX}`,
    name: `${device.name} batteries`,
    class: 'battery',
    virtualClass: null,
    settings: {},
    capabilities,
    capabilitiesObj,
  };
}

/**
 * The P1 as it is, and its battery group as its own battery. A Plug-In
 * Battery's own device is read by no view: its group is the battery.
 */
function projectHomeWizardRead(device: HomeyDeviceLike): readonly HomeyDeviceLike[] {
  if (isPlugInBattery(device)) return [];
  return isP1(device) && holdsBatteryGroup(device) ? [device, groupView(device)] : [device];
}

/** `device` is the P1's accepted read: a group report goes to the battery view, by its name there. */
function routeHomeWizardReport(device: HomeyDeviceLike, capabilityId: string): CapabilityRoute {
  const renamed = isP1(device) && holdsBatteryGroup(device) ? GROUP_RENAMES[capabilityId] : undefined;
  return renamed === undefined
    ? { deviceId: device.id, capabilityId }
    : { deviceId: `${device.id}${GROUP_SUFFIX}`, capabilityId: renamed };
}

const readPositiveW = (values: DeviceCapabilityMap, capabilityId: string): number | undefined => {
  const value = values[capabilityId]?.value;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * The group's mode is its command (`notes/battery-vendor-bindings.md`): it
 * discharges to cover the house's import, stands by, charges from surplus
 * only, or charges at full power, from the grid when surplus falls short. Its
 * limits come from the P1: the app publishes them as the batteries report
 * them, and the firmware's limit can be one battery's even with several.
 */
const GROUP_BINDING: HomeBatteryModeBinding = {
  kind: 'meter_modes',
  claimCapabilityId: MODE,
  rejection: 'unanswered',
  modes: {
    discharge: 'zero_discharge_only', hold: 'standby', chargeSurplus: 'zero_charge_only', chargeGrid: 'to_full',
  },
  // Predictive is HomeWizard's own Smart Charging: it plans grid charging itself.
  ownGridChargingModes: ['predictive'],
  resolvePowers: (values) => {
    const maxDischargeW = readPositiveW(values, MAX_DISCHARGE);
    const maxChargeW = readPositiveW(values, MAX_CHARGE);
    return maxDischargeW === undefined || maxChargeW === undefined ? undefined : { maxDischargeW, maxChargeW };
  },
};

const homeWizardBatteryBinding = (device: HomeyDeviceLike): HomeBatteryBinding => (
  isGroupView(device) ? GROUP_BINDING : STANDARD_HOME_BATTERY_BINDING
);

const homeWizardSourceDeviceId = (view: HomeyDeviceLike): string => (
  isGroupView(view) ? view.id.slice(0, -GROUP_SUFFIX.length) : view.id
);

export const homeWizardAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isP1(device) || isPlugInBattery(device),
  projectRead: projectHomeWizardRead,
  routeReport: routeHomeWizardReport,
  homeBatteryBinding: homeWizardBatteryBinding,
  sourceDeviceId: homeWizardSourceDeviceId,
};
