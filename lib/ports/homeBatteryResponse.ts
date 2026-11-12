import type { HomeBatteryMeterModes, HomeBatteryResponse } from '../../packages/contracts/src/types';

/**
 * The mode a meter-following battery takes for a setpoint in PELS's sign
 * (`HomeBatteryResponse`): any discharge covers the house's import, 0 W holds,
 * a charge below the fixed grid-charge power is taken from surplus only, and
 * a charge at it charges at that power, from the grid when the surplus falls
 * short. The planner plans a grid charge only at that power
 * (`BatteryEnergyModel.gridCharge`), and a capacity cap that lowers the
 * setpoint below it falls back to surplus only, which never imports.
 */
export const meterModeFor = (modes: HomeBatteryMeterModes, setpointW: number): string => {
  if (setpointW < 0) return modes.discharge;
  if (setpointW === 0) return modes.hold;
  return setpointW >= modes.gridChargeW ? modes.chargeGrid : modes.chargeSurplus;
};

/** The claim values PELS writes to drive a battery: the one claim value, or every command mode. */
export const pelsClaimValues = (response: HomeBatteryResponse): readonly string[] => (
  response.kind === 'delivers_setpoint'
    ? [response.claimValue]
    : [response.modes.discharge, response.modes.hold, response.modes.chargeSurplus, response.modes.chargeGrid]
);

/** Whether a reported claim value is one PELS drives the battery with: under PELS's claim, or anyone's. */
export const isPelsClaimValue = (response: HomeBatteryResponse, value: string): boolean => (
  pelsClaimValues(response).includes(value)
);

/** Whether two responses describe the same control. */
export const isSameResponse = (a: HomeBatteryResponse, b: HomeBatteryResponse): boolean => {
  if (a.kind === 'delivers_setpoint') return b.kind === 'delivers_setpoint' && a.claimValue === b.claimValue;
  if (b.kind !== 'follows_meter') return false;
  const am = a.modes;
  const bm = b.modes;
  return am.discharge === bm.discharge && am.hold === bm.hold && am.chargeSurplus === bm.chargeSurplus
    && am.chargeGrid === bm.chargeGrid && am.gridChargeW === bm.gridChargeW;
};
