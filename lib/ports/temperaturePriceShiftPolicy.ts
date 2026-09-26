/** The thermostat policy operations needed when an outside temperature change is adopted. */
export type ManualTemperaturePriceShiftPolicy = {
  cancelCurrentPriceShift: (deviceId: string) => boolean;
  allowsCurrentPriceShiftTarget: (deviceId: string, modeTargetC: number, candidateC: number) => boolean;
};
