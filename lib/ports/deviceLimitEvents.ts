import type { HomeId } from '../utils/settingsKeys';
import type { DeviceLimitDecision } from '../planContract/executionPlan';

export type DeviceLimitAction = 'turned_off' | 'temperature_setback' | 'lower_step';

export type DeviceLimitChange =
  | ({ kind: 'limited'; action: DeviceLimitAction } & DeviceLimitDecision)
  | { kind: 'resumed' };

type EventDevice = { deviceId: string; deviceName: string; atMs: number };

/** An execution outcome with the first limit time for the corresponding resume. */
export type DeviceLimitEvent = EventDevice & (
  | Extract<DeviceLimitChange, { kind: 'limited' }>
  | { kind: 'resumed'; limitedAtMs: number }
);

export type DeviceLimitRecorder = (
  deviceId: string, deviceName: string, atMs: number, change: DeviceLimitChange,
) => void;

/** Attribution retained with a stepped command until a matching report settles it. */
export type SteppedDeviceLimitChange = { homeId: HomeId; deviceName: string; change: DeviceLimitChange };
