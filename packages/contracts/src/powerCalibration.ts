/**
 * Per-device-per-step power calibration contract.
 *
 * Persists an EMA of the measured power a stepped device delivers while at a
 * given step, together with enough metadata to gate confidence and detect
 * nameplate changes. Used by the planner and horizon planner to pick
 * admission and delivery estimates without falling back to static nameplate
 * values once enough evidence is available. Samples outside the configured
 * step band are rejected by the runtime recorder before they update the EMA.
 *
 * Types only — the runtime value `POWER_CALIBRATION_VERSION` and the factory
 * `createEmptyPowerCalibrationSnapshot` live in
 * `lib/observer/devicePowerCalibration.ts` so Homey runtime code does not
 * value-import from contracts (which is deploy-excluded). The settings UI
 * may import the runtime version via `packages/shared-domain/**` if it ever
 * needs to inspect calibration state.
 */

export type PowerCalibrationVersion = 1;

export type StepCalibration = {
  /** EMA (kW) of measured power while the device reports being at this step. */
  observedKw: number;
  /** Nameplate (kW) active when the EMA was built; reset when this drifts. */
  nameplateAtSampleKw: number;
  /** Number of samples merged into observedKw. */
  samples: number;
  /** Cumulative observed seconds the device was confirmed at this step. */
  sustainedSeconds: number;
  /** Timestamp (ms) of the last recorded sample. */
  lastSampleMs: number;
};

export type DeviceCalibration = {
  /** Calibration per step id. Off-step entries are not recorded. */
  steps: Record<string, StepCalibration>;
  /** Timestamp (ms) of the last recorded sample across any step on this device. */
  lastTouchedMs: number;
};

export type PowerCalibrationSnapshot = {
  version: PowerCalibrationVersion;
  devices: Record<string, DeviceCalibration>;
};
