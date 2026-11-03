import type {
  ContestKind,
  ContestedControl,
  ContestedSetting,
} from '../../packages/contracts/src/controlContest';
import { getLogger } from '../logging/logger';
import type {
  ControlCommandSent,
  ControlContestRecording,
  ControlValue,
  PlannedControls,
} from '../ports/controlContest';
import type { DeviceJournal } from '../ports/deviceJournal';
import type { HomeId } from '../utils/settingsKeys';

/**
 * How many rounds on one setting, within {@link CONTEST_WINDOW_MS}, make a
 * device contested. A person nudging a thermostat back once or twice is not a
 * contest; a Flow, app or schedule rewriting a setting on a timer is.
 */
export const CONTEST_THRESHOLD = 4;
export const CONTEST_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * How long the device must have read a command before PELS's next send of it
 * can be a round. Homey publishes a capability only when its value changes,
 * so PELS never hears that a device kept a value, and "confirmed" means only
 * that Homey stored PELS's write. A device that clamps or rounds a setpoint
 * (a cloud thermostat that turns 5 °C into its own 7 °C minimum) reads PELS's
 * value until its next poll reports its own: confirmed, then moved, on every
 * poll. A device that has read PELS's value this long kept it.
 */
export const CONTEST_SETTLE_MS = 15 * 60 * 1000;
/** The rounds the journalled event carries, newest last. */
const CONTEST_EVENT_MAX_ROUNDS = 8;
const SETTINGS: readonly ContestedSetting[] = ['temperature', 'on_off', 'level'];

/**
 * `before`: the device's value when PELS first asked for `value`, kept while
 * PELS keeps asking for it, so every round compares with the value PELS took
 * the setting from.
 */
type Command = { value: ControlValue; before?: ControlValue };
/**
 * `homeId`: the home whose executor sent it latest. `sentAtMs`: PELS's latest
 * send of the command. `confirmedAtMs`: the first confirmation after it, never
 * earlier than the send; absent while the device has not confirmed that send.
 */
type SettingCommand = {
  homeId: HomeId;
  deviceId: string;
  setting: ContestedSetting;
  command: Command;
  sentAtMs: number;
  confirmedAtMs?: number;
};
type ContestRound = {
  atMs: number;
  setting: ContestedSetting;
  commanded: ControlValue;
  observed: ControlValue;
  kind: ContestKind;
};

const logger = getLogger('executor/control-contest');

const settingKey = (deviceId: string, setting: ContestedSetting): string => `${deviceId}\u0000${setting}`;

/** Whether the device has read the command long enough for a move away from it to be a round. */
const isSettled = (standing: SettingCommand, atMs: number): boolean => (
  standing.confirmedAtMs !== undefined && atMs - standing.confirmedAtMs >= CONTEST_SETTLE_MS
);

/** Every round a revert means PELS's writes do not stick; any other is an outside actor. */
const contestKind = (rounds: readonly ContestRound[]): ContestKind => (
  rounds.every((round) => round.kind === 'reverted') ? 'reverted' : 'overridden'
);

/**
 * The executor's record of drift corrections: a device that kept what PELS
 * set, then moved away from it, and that PELS set back. It sits with the
 * executor because the executor owns confirmation, which is what separates a
 * correction from the retries of a command the device never took.
 *
 * Per device and setting it keeps the command PELS stands behind and when the
 * device confirmed it:
 * - `commandSent` with the same value as a command the device confirmed at
 *   least {@link CONTEST_SETTLE_MS} earlier, while the device reads another
 *   value, is a round. A command confirmed more recently is retried, not
 *   counted: a device that clamps a setpoint reads PELS's value only until
 *   its next poll. Every send leaves the command unconfirmed, so a
 *   correction that does not stick in turn is retried, not counted again. A
 *   round is `reverted` when the device went back to its value from before
 *   PELS first asked; an on/off round is always `overridden`, since a
 *   two-valued setting cannot tell the two apart.
 * - `commandConfirmed` notes when the device first confirmed the standing
 *   command after its latest send.
 * - `retainPlanned` drops a command the plan just built no longer asks for,
 *   or whose device left that home's plan, and `commandReleased` one whose
 *   command session ended: a device that moves while PELS is not holding it
 *   is not contesting anything.
 *
 * When one setting has {@link CONTEST_THRESHOLD} rounds within
 * {@link CONTEST_WINDOW_MS}, the device is contested. The first time in a
 * window it records `device_control_contested` in the structured log and the
 * device journal, so the owner's event reports
 * (`lib/diagnostics/eventReportSchedule.ts`) can send a report while the
 * evidence is fresh. Correction keeps running: this only warns and reports.
 *
 * One record serves every home; device ids are globally unique. Each
 * command carries the home that sent it, since a home's plan holds only its
 * own devices: a device absent from it is released only by the home that
 * sent its command.
 */
export class ControlContestRecord implements ControlContestRecording {
  private readonly commands = new Map<string, SettingCommand>();
  private readonly rounds = new Map<string, ContestRound[]>();
  /**
   * When each setting's latest contest began: the first of the rounds that
   * reached the threshold. Rounds only age out between rounds, so a setting
   * that already had the threshold before a round has been contested since.
   */
  private readonly contestSinceMs = new Map<string, number>();
  private readonly reportedAtMs = new Map<string, number>();

  constructor(private readonly journal: DeviceJournal) {}

  commandSent(sent: ControlCommandSent): void {
    const key = settingKey(sent.deviceId, sent.setting);
    const standing = this.commands.get(key);
    const sameValue = standing !== undefined && Object.is(standing.command.value, sent.value);
    const { observed } = sent;
    if (
      sameValue && isSettled(standing, sent.atMs) && observed !== undefined && !Object.is(observed, sent.value)
    ) {
      this.noteRound(sent, observed, standing.command);
    }
    this.commands.set(key, {
      homeId: sent.homeId,
      deviceId: sent.deviceId,
      setting: sent.setting,
      command: sameValue ? standing.command : {
        value: sent.value,
        ...(observed === undefined ? {} : { before: observed }),
      },
      sentAtMs: sent.atMs,
    });
  }

  /** The device read `value` at `atMs`; only the first confirmation after a send counts. */
  commandConfirmed(deviceId: string, setting: ContestedSetting, value: ControlValue, atMs: number): void {
    const key = settingKey(deviceId, setting);
    const standing = this.commands.get(key);
    if (!standing || !Object.is(standing.command.value, value) || standing.confirmedAtMs !== undefined) return;
    this.commands.set(key, { ...standing, confirmedAtMs: Math.max(atMs, standing.sentAtMs) });
  }

  commandReleased(deviceId: string, setting: ContestedSetting): void {
    this.commands.delete(settingKey(deviceId, setting));
  }

  /** Whether PELS stands behind any command; with none, there is nothing to retain. */
  hasStandingCommands(): boolean {
    return this.commands.size > 0;
  }

  retainPlanned(homeId: HomeId, planned: ReadonlyMap<string, PlannedControls>): void {
    for (const [key, standing] of this.commands) {
      const controls = planned.get(standing.deviceId);
      const released = controls === undefined
        ? standing.homeId === homeId
        : !Object.is(standing.command.value, controls[standing.setting]);
      if (released) this.commands.delete(key);
    }
  }

  /**
   * The device's contest at `nowMs`: its setting with the most rounds in the
   * window, while they reach the threshold, and when that contest began.
   */
  contestedControl(deviceId: string, nowMs: number): ContestedControl | undefined {
    let contested: ContestedControl | undefined;
    for (const setting of SETTINGS) {
      const rounds = this.roundsWithin(deviceId, setting, nowMs);
      const sinceMs = this.contestSinceMs.get(settingKey(deviceId, setting));
      if (rounds.length < CONTEST_THRESHOLD || sinceMs === undefined) continue;
      if (contested && contested.count >= rounds.length) continue;
      contested = { setting, kind: contestKind(rounds), count: rounds.length, sinceMs };
    }
    return contested;
  }

  private roundsWithin(deviceId: string, setting: ContestedSetting, nowMs: number): ContestRound[] {
    return (this.rounds.get(settingKey(deviceId, setting)) ?? [])
      .filter((round) => nowMs - round.atMs < CONTEST_WINDOW_MS);
  }

  private noteRound(sent: ControlCommandSent, observed: ControlValue, standing: Command): void {
    const round: ContestRound = {
      atMs: sent.atMs,
      setting: sent.setting,
      commanded: sent.value,
      observed,
      // An on/off setting has two values, so going back to the earlier one says
      // nothing about what moved it: every such round is `overridden`.
      kind: sent.setting !== 'on_off' && Object.is(observed, standing.before) ? 'reverted' : 'overridden',
    };
    const key = settingKey(sent.deviceId, sent.setting);
    const rounds = [...this.roundsWithin(sent.deviceId, sent.setting, sent.atMs), round];
    this.rounds.set(key, rounds);
    if (rounds.length < CONTEST_THRESHOLD) return;
    // `rounds` ends with `round`, so its head is always present.
    const firstAtMs = (rounds[0] ?? round).atMs;
    if (rounds.length === CONTEST_THRESHOLD) this.contestSinceMs.set(key, firstAtMs);
    const lastAtMs = this.reportedAtMs.get(sent.deviceId);
    if (lastAtMs !== undefined && sent.atMs - lastAtMs < CONTEST_WINDOW_MS) return;
    this.reportedAtMs.set(sent.deviceId, sent.atMs);
    const event = {
      component: 'executor',
      event: 'device_control_contested',
      deviceId: sent.deviceId,
      deviceName: sent.deviceName,
      setting: sent.setting,
      kind: contestKind(rounds),
      windowMs: CONTEST_WINDOW_MS,
      count: rounds.length,
      firstAtMs,
      rounds: rounds.slice(-CONTEST_EVENT_MAX_ROUNDS),
    };
    logger.info(event);
    this.journal.record([sent.deviceId], event);
  }
}
