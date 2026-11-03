import type {
  ContestedControl,
  ContestedSetting,
} from '../../packages/contracts/src/controlContest';
import { getLogger } from '../logging/logger';
import type {
  ControlCommandSent,
  ControlContestRecording,
  ControlReported,
  ControlValue,
  PlannedControls,
} from '../ports/controlContest';
import type { DeviceJournal } from '../ports/deviceJournal';

/**
 * How many rounds on one setting, within {@link CONTEST_WINDOW_MS}, make a
 * device contested. A person nudging a thermostat back once or twice an hour
 * is not a contest; a device, Flow, app or schedule that keeps moving a
 * setting is.
 */
export const CONTEST_THRESHOLD = 4;
export const CONTEST_WINDOW_MS = 60 * 60 * 1000;
/** The rounds the journalled event carries, newest last. */
const CONTEST_EVENT_MAX_ROUNDS = 8;
const SETTINGS: readonly ContestedSetting[] = ['temperature', 'on_off', 'level'];

/**
 * `contradiction`: the device's latest own report of the setting, after PELS
 * sent `value`, when it was another value.
 */
type StandingCommand = {
  value: ControlValue;
  sentAtMs: number;
  contradiction?: { value: ControlValue; reportedAtMs: number };
};
type ContestRound = {
  atMs: number;
  setting: ContestedSetting;
  commanded: ControlValue;
  observed: ControlValue;
};

const logger = getLogger('executor/control-contest');

const settingKey = (deviceId: string, setting: ContestedSetting): string => `${deviceId}\u0000${setting}`;

/**
 * The executor's record of settings that do not keep what PELS sets. It counts
 * what PELS measures and blames no one: Homey reports a value without saying
 * who set it, and never repeats a value a device already holds, so a device
 * that cannot hold the value, a Flow, an app and a schedule look the same.
 *
 * Per device and setting it keeps the command PELS stands behind:
 * - `controlReported`: the device's own report of the setting, which is never
 *   the echo of PELS's write (`lib/device/transport/ownCapabilityWrites.ts`).
 *   A report of another value after PELS sent the command contradicts it.
 * - `commandSent` with the value PELS stands behind, after a contradiction, is
 *   a round: PELS set it, the device reported another value, PELS set it again.
 *   A retry with no report in between is no round.
 * - `retainPlanned` drops a command the plan just built no longer asks for,
 *   and `commandReleased` one whose command session ended: a device that
 *   moves while PELS is not holding it is not contesting anything.
 *
 * When one setting has {@link CONTEST_THRESHOLD} rounds within
 * {@link CONTEST_WINDOW_MS}, the device is contested. The first time in a
 * window it records `device_control_contested` in the structured log and the
 * device journal, so the owner's event reports
 * (`lib/diagnostics/eventReportSchedule.ts`) can send a report while the
 * evidence is fresh. PELS keeps setting the device: this only warns and reports.
 *
 * One record serves every home; device ids are globally unique.
 */
export class ControlContestRecord implements ControlContestRecording {
  private readonly commands = new Map<string, StandingCommand>();
  private readonly rounds = new Map<string, ContestRound[]>();
  private readonly reportedAtMs = new Map<string, number>();

  constructor(private readonly journal: DeviceJournal) {}

  controlReported(report: ControlReported): void {
    const key = settingKey(report.deviceId, report.setting);
    const standing = this.commands.get(key);
    if (!standing || Object.is(report.value, standing.value) || report.reportedAtMs < standing.sentAtMs) return;
    this.commands.set(key, { ...standing, contradiction: { value: report.value, reportedAtMs: report.reportedAtMs } });
  }

  commandSent(sent: ControlCommandSent): void {
    const key = settingKey(sent.deviceId, sent.setting);
    const standing = this.commands.get(key);
    if (standing?.contradiction && Object.is(standing.value, sent.value)) {
      this.noteRound(sent, standing.contradiction.value);
    }
    this.commands.set(key, { value: sent.value, sentAtMs: sent.atMs });
  }

  commandReleased(deviceId: string, setting: ContestedSetting): void {
    this.commands.delete(settingKey(deviceId, setting));
  }

  /** Whether PELS stands behind any command; with none, there is nothing to retain. */
  hasStandingCommands(): boolean {
    return this.commands.size > 0;
  }

  retainPlanned(deviceId: string, planned: PlannedControls): void {
    for (const setting of SETTINGS) {
      const key = settingKey(deviceId, setting);
      const standing = this.commands.get(key);
      if (standing && !Object.is(standing.value, planned[setting])) this.commands.delete(key);
    }
  }

  /**
   * The device's contest at `nowMs`: its setting with the most rounds in the
   * window, while they reach the threshold, with the values of the latest.
   */
  contestedControl(deviceId: string, nowMs: number): ContestedControl | undefined {
    let contested: ContestedControl | undefined;
    for (const setting of SETTINGS) {
      const rounds = this.roundsWithin(deviceId, setting, nowMs);
      const first = rounds[0];
      const latest = rounds[rounds.length - 1];
      if (!first || !latest || rounds.length < CONTEST_THRESHOLD) continue;
      if (contested && contested.count >= rounds.length) continue;
      contested = {
        setting,
        commanded: latest.commanded,
        observed: latest.observed,
        count: rounds.length,
        sinceMs: first.atMs,
      };
    }
    return contested;
  }

  private roundsWithin(deviceId: string, setting: ContestedSetting, nowMs: number): ContestRound[] {
    return (this.rounds.get(settingKey(deviceId, setting)) ?? [])
      .filter((round) => nowMs - round.atMs < CONTEST_WINDOW_MS);
  }

  private noteRound(sent: ControlCommandSent, observed: ControlValue): void {
    const round: ContestRound = { atMs: sent.atMs, setting: sent.setting, commanded: sent.value, observed };
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
      commanded: round.commanded,
      observed: round.observed,
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
