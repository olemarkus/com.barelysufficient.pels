import type {
  ContestKind,
  ContestedControl,
  ContestedSetting,
} from '../../packages/contracts/src/controlContest';
import { getLogger } from '../logging/logger';
import type { DeviceJournal } from '../ports/deviceJournal';

/**
 * How many rounds on one setting, within {@link CONTEST_WINDOW_MS}, make a
 * device contested. A person nudging a thermostat back once or twice an hour
 * is not a contest; a Flow, app or schedule rewriting a setting on a timer is.
 */
export const CONTEST_THRESHOLD = 4;
export const CONTEST_WINDOW_MS = 60 * 60 * 1000;
/** The rounds the journalled event carries, newest last. */
const CONTEST_EVENT_MAX_ROUNDS = 8;
const SETTINGS: readonly ContestedSetting[] = ['temperature', 'on_off', 'level'];

/** A setpoint, an on/off state or a step id. */
export type ControlValue = number | boolean | string;

/** What the plan just built asks of each setting; `null` where it asks nothing. */
export type PlannedControls = Readonly<Record<ContestedSetting, ControlValue | null>>;

/** One command PELS sent, with the device's value for that setting just before. */
export type ControlCommandSent = {
  deviceId: string;
  deviceName: string;
  setting: ContestedSetting;
  value: ControlValue;
  /** `undefined` when the device had not reported the setting. */
  observed: ControlValue | undefined;
  atMs: number;
};

/**
 * `before`: the device's value when PELS first asked for `value`, kept while
 * PELS keeps asking for it, so every round compares with the value PELS took
 * the setting from.
 */
type Command = { value: ControlValue; before?: ControlValue };
type SettingCommand = { command: Command; confirmed: boolean };
type ContestRound = {
  atMs: number;
  setting: ContestedSetting;
  commanded: ControlValue;
  observed: ControlValue;
  kind: ContestKind;
};

const logger = getLogger('executor/control-contest');

const settingKey = (deviceId: string, setting: ContestedSetting): string => `${deviceId}\u0000${setting}`;

/** Every round a revert means PELS's writes do not stick; any other is an outside actor. */
const contestKind = (rounds: readonly ContestRound[]): ContestKind => (
  rounds.every((round) => round.kind === 'reverted') ? 'reverted' : 'overridden'
);

/**
 * The executor's record of drift corrections: a device that confirmed what
 * PELS set, then moved away from it, and that PELS set back. It sits with the
 * executor because the executor owns confirmation, which is what separates a
 * correction from the retries of a command the device never took (a
 * thermostat that clamps 5 °C to 7 °C stays unconfirmed, and its retries are
 * never rounds).
 *
 * Per device and setting it keeps the command PELS stands behind and whether
 * the device confirmed it:
 * - `commandSent` with the same value as a confirmed command, while the
 *   device reads another value, is a round. Every send leaves the command
 *   unconfirmed, so a correction that does not stick in turn is retried, not
 *   counted again.
 * - `commandConfirmed` marks the standing command confirmed.
 * - `retainPlanned` drops a command the plan just built no longer asks for,
 *   and `commandReleased` one whose command session ended: a device that
 *   moves while PELS is not holding it is not contesting anything.
 *
 * When one setting has {@link CONTEST_THRESHOLD} rounds within
 * {@link CONTEST_WINDOW_MS}, the device is contested. The first time in a
 * window it records `device_control_contested` in the structured log and the
 * device journal, so the owner's event reports
 * (`lib/diagnostics/eventReportSchedule.ts`) can send a report while the
 * evidence is fresh. Correction keeps running: this only warns and reports.
 *
 * One record serves every home; device ids are globally unique.
 */
export class ControlContestRecord {
  private readonly commands = new Map<string, SettingCommand>();
  private readonly rounds = new Map<string, ContestRound[]>();
  private readonly reportedAtMs = new Map<string, number>();

  constructor(private readonly journal: DeviceJournal) {}

  commandSent(sent: ControlCommandSent): void {
    const key = settingKey(sent.deviceId, sent.setting);
    const standing = this.commands.get(key);
    const sameValue = standing !== undefined && Object.is(standing.command.value, sent.value);
    const { observed } = sent;
    if (sameValue && standing.confirmed && observed !== undefined && !Object.is(observed, sent.value)) {
      this.noteRound(sent, observed, standing.command);
    }
    this.commands.set(key, {
      command: sameValue ? standing.command : {
        value: sent.value,
        ...(observed === undefined ? {} : { before: observed }),
      },
      confirmed: false,
    });
  }

  commandConfirmed(deviceId: string, setting: ContestedSetting, value: ControlValue): void {
    const key = settingKey(deviceId, setting);
    const standing = this.commands.get(key);
    if (standing && Object.is(standing.command.value, value)) this.commands.set(key, { ...standing, confirmed: true });
  }

  commandReleased(deviceId: string, setting: ContestedSetting): void {
    this.commands.delete(settingKey(deviceId, setting));
  }

  retainPlanned(deviceId: string, planned: PlannedControls): void {
    for (const setting of SETTINGS) {
      const key = settingKey(deviceId, setting);
      const standing = this.commands.get(key);
      if (standing && !Object.is(standing.command.value, planned[setting])) this.commands.delete(key);
    }
  }

  /**
   * The device's contest at `nowMs`: its setting with the most rounds in the
   * window, while they reach the threshold.
   */
  contestedControl(deviceId: string, nowMs: number): ContestedControl | undefined {
    let contested: ContestedControl | undefined;
    for (const setting of SETTINGS) {
      const rounds = this.roundsWithin(deviceId, setting, nowMs);
      const [first] = rounds;
      if (!first || rounds.length < CONTEST_THRESHOLD) continue;
      if (contested && contested.count >= rounds.length) continue;
      contested = { setting, kind: contestKind(rounds), count: rounds.length, sinceMs: first.atMs };
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
      kind: Object.is(observed, standing.before) ? 'reverted' : 'overridden',
    };
    const rounds = [...this.roundsWithin(sent.deviceId, sent.setting, sent.atMs), round];
    this.rounds.set(settingKey(sent.deviceId, sent.setting), rounds);
    if (rounds.length < CONTEST_THRESHOLD) return;
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
      // `rounds` ends with `round`, so its head is always present.
      firstAtMs: (rounds[0] ?? round).atMs,
      rounds: rounds.slice(-CONTEST_EVENT_MAX_ROUNDS),
    };
    logger.info(event);
    this.journal.record([sent.deviceId], event);
  }
}
