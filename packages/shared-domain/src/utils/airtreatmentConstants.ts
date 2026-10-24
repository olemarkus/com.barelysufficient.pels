export const AIRTREATMENT_SHED_FLOOR_C = 16;
export const NON_ONOFF_TEMPERATURE_SHED_FLOOR_C = 10;
export const SHED_DEFAULT_DELTA_C = 3;
export const SHED_STEP_C = 0.5;
/**
 * The highest limit PELS picks on its own for a device whose setpoint is its
 * only way to shed. A water heater's mode target less the setback would let a
 * tank keep heating while it is limited, so the default stops here. A limit the
 * owner saves may go up to the device's own maximum.
 */
export const SETPOINT_SHED_DEFAULT_MAX_C = 40;
export const SHED_FALLBACK_TARGET_C = 20;
/**
 * The limit while cooling a setpoint shed carries until the owner sets their
 * own: the point a limited cooling device may let the room rise to.
 */
export const COOLING_SHED_DEFAULT_C = 28;
