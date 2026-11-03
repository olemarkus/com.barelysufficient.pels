import type {
  ContestedControl, ContestedSetting, ContestedValue,
} from '../../packages/contracts/src/controlContest';
import type { HomeId } from '../utils/settingsKeys';

/** A setpoint, an on/off state or a step id. */
export type ControlValue = ContestedValue;

/** What the plan just built asks of each setting; `null` where it asks nothing. */
export type PlannedControls = Readonly<Record<ContestedSetting, ControlValue | null>>;

/** One command PELS sent. */
export type ControlCommandSent = {
  /** The home whose executor sent it: only that home's plans let it go when the device leaves. */
  homeId: HomeId;
  deviceId: string;
  deviceName: string;
  setting: ContestedSetting;
  value: ControlValue;
  atMs: number;
};

/**
 * The device's own report of a setting: never Homey's echo of PELS's write
 * (`lib/device/transport/ownCapabilityWrites.ts`). Transport reports the switch
 * and the setpoint from the live feed, and the stepped command store the level.
 */
export type ControlReported = {
  deviceId: string;
  setting: ContestedSetting;
  value: ControlValue;
  reportedAtMs: number;
};

/**
 * The executor's record of settings that do not keep what PELS sets, as its
 * writers and the device's reports feed it: every home's execution state, the
 * stepped command store, and the observed-state events. One record serves the
 * app; `lib/executor/controlContest.ts` is the only implementation, and setup
 * hands it to each home by this port.
 */
export type ControlContestRecording = {
  commandSent(sent: ControlCommandSent): void;
  controlReported(report: ControlReported): void;
  commandReleased(deviceId: string, setting: ContestedSetting): void;
  /** `planned`: what `homeId`'s plan just built asks of each device it holds, by device id. */
  retainPlanned(homeId: HomeId, planned: ReadonlyMap<string, PlannedControls>): void;
};

/** The record's answer for one device, as the settings UI reads it. */
export type ControlContestReading = {
  contestedControl(deviceId: string, nowMs: number): ContestedControl | undefined;
};
