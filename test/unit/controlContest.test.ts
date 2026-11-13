import { describe, expect, it } from 'vitest';
import type { ContestedSetting } from '../../packages/contracts/src/controlContest';
import type { ControlValue } from '../../lib/ports/controlContest';
import { CONTEST_WINDOW_MS } from '../../lib/executor/controlContest';
import { controlContestsForTest } from '../helpers/controlContests';

const MINUTE_MS = 60_000;
const DEVICE = 'mill';

const sent = (atMs: number, value: ControlValue, setting: ContestedSetting = 'temperature') => (
  { homeId: 'main', deviceId: DEVICE, deviceName: 'Gang nede ovn', setting, value, atMs }
);
const reported = (reportedAtMs: number, value: ControlValue, setting: ContestedSetting = 'temperature') => (
  { deviceId: DEVICE, setting, value, reportedAtMs }
);

/** PELS sets 5 °C; then `moves` times the device reports `drifted` and PELS sets 5 °C again. */
const contestRounds = (moves: number, drifted: ControlValue = 22, everyMs = 10 * MINUTE_MS) => {
  const record = controlContestsForTest();
  record.contests.commandSent(sent(0, 5));
  for (let round = 1; round <= moves; round += 1) {
    record.contests.controlReported(reported(round * everyMs - MINUTE_MS, drifted));
    record.contests.commandSent(sent(round * everyMs, 5));
  }
  return record;
};

describe('ControlContestRecord', () => {
  it('counts a setting the device keeps reporting away from four times in an hour, and reports it once', () => {
    const { contests, journalled } = contestRounds(5);
    expect(contests.contestedControl(DEVICE, 50 * MINUTE_MS)).toEqual({
      setting: 'temperature', commanded: 5, observed: 22, count: 5, sinceMs: 10 * MINUTE_MS,
    });
    expect(journalled).toHaveLength(1);
    expect(journalled[0]).toEqual({
      deviceIds: [DEVICE],
      event: expect.objectContaining({
        event: 'device_control_contested', deviceId: DEVICE, deviceName: 'Gang nede ovn', setting: 'temperature',
        commanded: 5, observed: 22, count: 4, firstAtMs: 10 * MINUTE_MS,
      }),
    });
  });

  it('counts a device that never takes the value as the rounds it reports another value', () => {
    // A thermostat whose minimum is 7 °C: after every write of 5 °C it reports 7 °C again.
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, 5));
    for (let retry = 1; retry <= 4; retry += 1) {
      contests.controlReported(reported(retry * 10 * MINUTE_MS - MINUTE_MS, 7));
      contests.commandSent(sent(retry * 10 * MINUTE_MS, 5));
    }
    expect(contests.contestedControl(DEVICE, 40 * MINUTE_MS)).toEqual({
      setting: 'temperature', commanded: 5, observed: 7, count: 4, sinceMs: 10 * MINUTE_MS,
    });
  });

  it('never counts a retry with no report from the device in between', () => {
    const { contests, journalled } = controlContestsForTest();
    contests.commandSent(sent(0, 5));
    for (let retry = 1; retry <= 12; retry += 1) contests.commandSent(sent(retry * 15 * MINUTE_MS, 5));
    expect(contests.contestedControl(DEVICE, 3 * 60 * MINUTE_MS)).toBeUndefined();
    expect(journalled).toEqual([]);
  });

  it('counts a report only once, for the send after it', () => {
    const { contests } = contestRounds(3);
    contests.commandSent(sent(40 * MINUTE_MS, 5));
    contests.commandSent(sent(42 * MINUTE_MS, 5));
    contests.commandSent(sent(47 * MINUTE_MS, 5));
    expect(contests.contestedControl(DEVICE, 47 * MINUTE_MS)).toBeUndefined();
  });

  it('takes no contradiction from a report of the value PELS set, or one from before PELS set it', () => {
    const { contests } = contestRounds(3);
    contests.controlReported(reported(39 * MINUTE_MS, 5));
    contests.commandSent(sent(40 * MINUTE_MS, 5));
    contests.controlReported(reported(39 * MINUTE_MS, 22));
    contests.commandSent(sent(41 * MINUTE_MS, 5));
    expect(contests.contestedControl(DEVICE, 41 * MINUTE_MS)).toBeUndefined();
  });

  it('keeps the latest report when the device reports more than once between sends', () => {
    const { contests } = contestRounds(3);
    contests.controlReported(reported(38 * MINUTE_MS, 22));
    contests.controlReported(reported(39 * MINUTE_MS, 24));
    contests.commandSent(sent(40 * MINUTE_MS, 5));
    expect(contests.contestedControl(DEVICE, 40 * MINUTE_MS)).toMatchObject({ observed: 24, count: 4 });
  });

  it('counts on/off rounds with the value the device reported', () => {
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, false, 'on_off'));
    for (let round = 1; round <= 4; round += 1) {
      contests.controlReported(reported(round * MINUTE_MS - 1_000, true, 'on_off'));
      contests.commandSent(sent(round * MINUTE_MS, false, 'on_off'));
    }
    expect(contests.contestedControl(DEVICE, 4 * MINUTE_MS)).toEqual({
      setting: 'on_off', commanded: false, observed: true, count: 4, sinceMs: MINUTE_MS,
    });
  });

  it('is no round when PELS sends another value', () => {
    const { contests } = contestRounds(3);
    contests.controlReported(reported(39 * MINUTE_MS, 22));
    contests.commandSent(sent(40 * MINUTE_MS, 6));
    expect(contests.contestedControl(DEVICE, 40 * MINUTE_MS)).toBeUndefined();
  });

  it('forgets a command the plan no longer asks for, so asking again is a new command', () => {
    const { contests } = contestRounds(3);
    contests.retainPlanned('main', new Map([[DEVICE, { temperature: 21, on_off: null, level: null, charging_phases: null }]]));
    contests.controlReported(reported(34 * MINUTE_MS, 22));
    contests.commandSent(sent(35 * MINUTE_MS, 5));
    expect(contests.contestedControl(DEVICE, 35 * MINUTE_MS)).toBeUndefined();
  });

  it('keeps the command the plan still asks for', () => {
    const { contests } = contestRounds(3);
    contests.retainPlanned('main', new Map([[DEVICE, { temperature: 5, on_off: null, level: null, charging_phases: null }]]));
    contests.controlReported(reported(34 * MINUTE_MS, 22));
    contests.commandSent(sent(35 * MINUTE_MS, 5));
    expect(contests.contestedControl(DEVICE, 35 * MINUTE_MS)?.count).toBe(4);
  });

  it('forgets the commands of a device that left its home\'s plan, and only that home\'s', () => {
    const { contests } = contestRounds(3);
    // A meter area's device, which the Main home's plan never holds.
    const annex = (atMs: number) => ({ ...sent(atMs, 5), homeId: 'area', deviceId: 'annex' });
    contests.commandSent(annex(0));
    for (let round = 1; round <= 3; round += 1) {
      contests.controlReported({ ...reported(round * 10 * MINUTE_MS - MINUTE_MS, 22), deviceId: 'annex' });
      contests.commandSent(annex(round * 10 * MINUTE_MS));
    }

    // Main's plan no longer holds the heater (its owner stopped managing it).
    contests.controlReported(reported(39 * MINUTE_MS, 22));
    contests.controlReported({ ...reported(39 * MINUTE_MS, 22), deviceId: 'annex' });
    contests.retainPlanned('main', new Map());
    contests.commandSent(sent(40 * MINUTE_MS, 5));
    contests.commandSent(annex(40 * MINUTE_MS));
    expect(contests.contestedControl(DEVICE, 40 * MINUTE_MS)).toBeUndefined();
    expect(contests.contestedControl('annex', 40 * MINUTE_MS)?.count).toBe(4);
  });

  it('forgets a command whose session ended', () => {
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, 'max', 'level'));
    contests.commandReleased(DEVICE, 'level');
    for (let round = 1; round <= 4; round += 1) {
      contests.controlReported(reported(round * MINUTE_MS - 1_000, 'low', 'level'));
      contests.commandSent(sent(round * MINUTE_MS, 'max', 'level'));
    }
    // The first send after the release is a new command, so four cycles make three rounds.
    expect(contests.contestedControl(DEVICE, 4 * MINUTE_MS)).toBeUndefined();
  });

  it('keeps a contest until its latest round is an hour old', () => {
    // Rounds at 15, 30, 45 and 60 minutes, then the device keeps PELS's value.
    const { contests } = contestRounds(4, 22, 15 * MINUTE_MS);
    expect(contests.contestedControl(DEVICE, 60 * MINUTE_MS)?.count).toBe(4);
    expect(contests.contestedControl(DEVICE, 15 * MINUTE_MS + CONTEST_WINDOW_MS)).toEqual({
      setting: 'temperature', commanded: 5, observed: 22, count: 3, sinceMs: 15 * MINUTE_MS,
    });
    expect(contests.contestedControl(DEVICE, 60 * MINUTE_MS + CONTEST_WINDOW_MS - 1)?.count).toBe(1);
    expect(contests.contestedControl(DEVICE, 60 * MINUTE_MS + CONTEST_WINDOW_MS)).toBeUndefined();
  });

  it.each([15, 16])('keeps one contest, shown throughout, for a device that reports another value every %i minutes', (
    minutes,
  ) => {
    // A round about every 15 minutes keeps 3 or 4 in the hour: at exactly 15,
    // the first round is exactly an hour old when the fifth lands.
    const everyMs = minutes * MINUTE_MS;
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, 5));
    const shownSinceMs = new Set<number | undefined>();
    for (let round = 1; round <= 12; round += 1) {
      for (let atMs = (round - 1) * everyMs; round > 4 && atMs < round * everyMs; atMs += MINUTE_MS) {
        shownSinceMs.add(contests.contestedControl(DEVICE, atMs)?.sinceMs);
      }
      contests.controlReported(reported(round * everyMs - MINUTE_MS, 7));
      contests.commandSent(sent(round * everyMs, 5));
    }
    // Shown at every minute from the fourth round on, with one start, so a dismissal sticks.
    expect([...shownSinceMs]).toEqual([everyMs]);
  });

  it('counts each setting on its own', () => {
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, 5));
    contests.commandSent(sent(0, false, 'on_off'));
    for (let round = 1; round <= 2; round += 1) {
      contests.controlReported(reported(round * MINUTE_MS - 1_000, 22));
      contests.commandSent(sent(round * MINUTE_MS, 5));
      contests.controlReported(reported(round * MINUTE_MS - 1_000, true, 'on_off'));
      contests.commandSent(sent(round * MINUTE_MS, false, 'on_off'));
    }
    expect(contests.contestedControl(DEVICE, 3 * MINUTE_MS)).toBeUndefined();
  });
});
