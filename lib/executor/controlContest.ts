import type {
  ContestedControl,
  ContestedSetting,
} from '../../packages/contracts/src/controlContest';
import { getLogger } from '../logging/logger';
import type {
  ControlCommandSent,
  ControlContestReading,
  ControlContestRecording,
  ControlReported,
  ControlValue,
  PlannedControls,
} from '../ports/controlContest';
import type { DeviceJournal } from '../ports/deviceJournal';
import type { HomeId } from '../utils/settingsKeys';

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
const SETTINGS: readonly ContestedSetting[] = ['temperature', 'on_off', 'level', 'charging_phases'];

/**
 * `homeId`: the home whose executor sent it latest. `contradiction`: the
 * device's latest own report of the setting, after PELS sent `value`, when it
 * was another value.
 */
type StandingCommand = {
  homeId: HomeId;
  deviceId: string;
  setting: ContestedSetting;
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
 *   or whose device left that home's plan, and `commandReleased` one whose
 *   command session ended: a device that moves while PELS is not holding it
 *   is not contesting anything.
 *
 * When one setting has {@link CONTEST_THRESHOLD} rounds within
 * {@link CONTEST_WINDOW_MS}, the device is contested, and it stays contested,
 * with the same start, until that setting's latest round is
 * {@link CONTEST_WINDOW_MS} old: a device that reports another value every 15
 * minutes keeps one contest running, rather than one that ends and starts
 * again as its first rounds age out. The first time in a window it records
 * `device_control_contested` in the structured log and the device journal, so
 * the owner's event reports
 * (`lib/diagnostics/eventReportSchedule.ts`) can send a report while the
 * evidence is fresh. PELS keeps setting the device: this only warns and reports.
 *
 * One record serves every home; device ids are globally unique. Each
 * command carries the home that sent it, since a home's plan holds only its
 * own devices: a device absent from it is released only by the home that
 * sent its command.
 */
export class ControlContestRecord implements ControlContestRecording, ControlContestReading {
  private readonly commands = new Map<string, StandingCommand>();
  private readonly rounds = new Map<string, ContestRound[]>();
  /**
   * When each setting's contest began: the first of the rounds that reached
   * the threshold. The contest runs while its latest round is within the
   * window; a round after that starts afresh.
   */
  private readonly contestSinceMs = new Map<string, number>();
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
    this.commands.set(key, {
      homeId: sent.homeId, deviceId: sent.deviceId, setting: sent.setting, value: sent.value, sentAtMs: sent.atMs,
    });
  }

  commandReleased(deviceId: string, setting: ContestedSetting): void {
    this.commands.delete(settingKey(deviceId, setting));
  }

  retainPlanned(homeId: HomeId, planned: ReadonlyMap<string, PlannedControls>): void {
    for (const [key, standing] of this.commands) {
      const controls = planned.get(standing.deviceId);
      const released = controls === undefined
        ? standing.homeId === homeId
        : !Object.is(standing.value, controls[standing.setting]);
      if (released) this.commands.delete(key);
    }
  }

  /**
   * The device's contest at `nowMs`: of its settings whose contest still runs,
   * the one with the most rounds in the window, with the values of the latest
   * round and when that contest began.
   */
  contestedControl(deviceId: string, nowMs: number): ContestedControl | undefined {
    let contested: ContestedControl | undefined;
    for (const setting of SETTINGS) {
      const rounds = this.roundsWithin(deviceId, setting, nowMs);
      const latest = rounds[rounds.length - 1];
      const sinceMs = this.contestSinceMs.get(settingKey(deviceId, setting));
      // With no round left in the window, the contest has ended.
      if (!latest || sinceMs === undefined) continue;
      if (contested && contested.count >= rounds.length) continue;
      contested = {
        setting,
        commanded: latest.commanded,
        observed: latest.observed,
        count: rounds.length,
        sinceMs,
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
    const key = settingKey(sent.deviceId, sent.setting);
    const earlier = this.roundsWithin(sent.deviceId, sent.setting, sent.atMs);
    const rounds = [...earlier, round];
    this.rounds.set(key, rounds);
    // `rounds` ends with `round`, so its head is always present.
    const firstAtMs = (rounds[0] ?? round).atMs;
    const running = earlier.length > 0 && this.contestSinceMs.has(key);
    if (!running && rounds.length >= CONTEST_THRESHOLD) this.contestSinceMs.set(key, firstAtMs);
    else if (!running) this.contestSinceMs.delete(key);
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
      firstAtMs,
      rounds: rounds.slice(-CONTEST_EVENT_MAX_ROUNDS),
    };
    logger.info(event);
    this.journal.record([sent.deviceId], event);
  }
}
