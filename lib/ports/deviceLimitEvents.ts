import type { HomeId } from '../utils/settingsKeys';
import type { DeviceLimitDecision } from '../planContract/executionPlan';

type AppliedDeviceLimit =
  | { action: 'turned_off' }
  | { action: 'temperature_setback'; temperatureC: number }
  | { action: 'lower_step'; stepId: string };

export type DeviceLimitChange =
  | ({ kind: 'limited' } & DeviceLimitDecision & AppliedDeviceLimit)
  | { kind: 'resumed' };

type EventDevice = { deviceId: string; deviceName: string; atMs: number };

/** An execution outcome with the first limit time for the corresponding resume. */
export type DeviceLimitEvent = EventDevice & (
  | ({ kind: 'limited'; action: AppliedDeviceLimit['action'] } & DeviceLimitDecision)
  | { kind: 'resumed'; limitedAtMs: number }
);

export type DeviceLimitRecorder = (
  deviceId: string, deviceName: string, atMs: number, change: DeviceLimitChange,
) => void;

/** Attribution retained with a stepped command until a matching report settles it. */
export type SteppedDeviceLimitChange = { homeId: HomeId; deviceName: string; change: DeviceLimitChange };
