/** An admitted external setpoint transition, resolved by the device observation producer. */
export type ExternalTemperatureAdjustment = {
  deviceId: string;
  temperature: number;
  observedAtMs: number;
};
