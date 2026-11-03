import type { ContestedSetting } from '../../packages/contracts/src/controlContest';
import type { HomeId } from '../utils/settingsKeys';

/** A setpoint, an on/off state or a step id. */
export type ControlValue = number | boolean | string;

/** What the plan just built asks of each setting; `null` where it asks nothing. */
export type PlannedControls = Readonly<Record<ContestedSetting, ControlValue | null>>;

/**
 * The device's reading of a setting and when the device was seen at it: the
 * observation's own time where the observer keeps one, else the send's.
 */
export type ObservedControl = { value: ControlValue; atMs: number };

/** One command PELS sent, with the device's reading of that setting just before. */
export type ControlCommandSent = {
  /** The home whose executor sent it: only that home's plans let it go when the device leaves. */
  homeId: HomeId;
  deviceId: string;
  deviceName: string;
  setting: ContestedSetting;
  value: ControlValue;
  /** `undefined` when the device had not reported the setting. */
  observed: ObservedControl | undefined;
  atMs: number;
};

/**
 * The executor's record of drift corrections as its writers feed it: every
 * home's execution state and the stepped command store. One record serves the
 * app; `lib/executor/controlContest.ts` is the only implementation, and setup
 * hands it to each home by this port.
 */
export type ControlContestRecording = {
  commandSent(sent: ControlCommandSent): void;
  /** The device read `value` at `atMs`, on the clock the send's `atMs` uses. */
  commandConfirmed(deviceId: string, setting: ContestedSetting, value: ControlValue, atMs: number): void;
  commandReleased(deviceId: string, setting: ContestedSetting): void;
  /** `planned`: what `homeId`'s plan just built asks of each device it holds, by device id. */
  retainPlanned(homeId: HomeId, planned: ReadonlyMap<string, PlannedControls>): void;
  hasStandingCommands(): boolean;
};
