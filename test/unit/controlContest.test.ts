import { describe, expect, it } from 'vitest';
import type { ContestedSetting } from '../../packages/contracts/src/controlContest';
import type { ControlValue } from '../../lib/ports/controlContest';
import { CONTEST_SETTLE_MS, CONTEST_WINDOW_MS } from '../../lib/executor/controlContest';
import { controlContestsForTest } from '../helpers/controlContests';

const MINUTE_MS = 60_000;
/** Past the settle: the device read PELS's value for longer than {@link CONTEST_SETTLE_MS} before it moved. */
const ROUND_MS = 20 * MINUTE_MS;
const DEVICE = 'mill';

const sent = (
  atMs: number,
  value: ControlValue,
  observed: ControlValue | undefined,
  setting: ContestedSetting = 'temperature',
) => ({ homeId: 'main', deviceId: DEVICE, deviceName: 'Gang nede ovn', setting, value, observed, atMs });

/**
 * PELS asks for 5 °C over 20 °C and the device confirms; then `moves` rounds of
 * `drifted`, each `everyMs` after the last, set back and confirmed at once.
 */
const contestRounds = (moves: number, drifted: (round: number) => ControlValue, everyMs = ROUND_MS) => {
  const record = controlContestsForTest();
  record.contests.commandSent(sent(0, 5, 20));
  record.contests.commandConfirmed(DEVICE, 'temperature', 5, 0);
  for (let round = 1; round <= moves; round += 1) {
    record.contests.commandSent(sent(round * everyMs, 5, drifted(round)));
    record.contests.commandConfirmed(DEVICE, 'temperature', 5, round * everyMs);
  }
  return record;
};

describe('ControlContestRecord', () => {
  it('never counts the retries of a command the device did not confirm', () => {
    // A thermostat that clamps 5 °C to 7 °C and never reads 5 °C: PELS retries on its ladder for hours.
    const { contests, journalled } = controlContestsForTest();
    contests.commandSent(sent(0, 5, 20));
    for (let retry = 1; retry <= 12; retry += 1) contests.commandSent(sent(retry * 15 * MINUTE_MS, 5, 7));
    expect(contests.contestedControl(DEVICE, 3 * 60 * MINUTE_MS)).toBeUndefined();
    expect(journalled).toEqual([]);
  });

  it('counts a setting the device kept, then moved away from, four times in 2 hours, and reports it once', () => {
    const { contests, journalled } = contestRounds(5, () => 22);
    expect(contests.contestedControl(DEVICE, 100 * MINUTE_MS)).toEqual({
      setting: 'temperature', kind: 'overridden', count: 5, sinceMs: ROUND_MS,
    });
    expect(journalled).toHaveLength(1);
    expect(journalled[0]).toEqual({
      deviceIds: [DEVICE],
      event: expect.objectContaining({
        event: 'device_control_contested', deviceId: DEVICE, deviceName: 'Gang nede ovn', setting: 'temperature',
        kind: 'overridden', count: 4, firstAtMs: ROUND_MS, windowMs: CONTEST_WINDOW_MS,
      }),
    });
  });

  it('never counts a setting the device read for less than the settle before PELS set it again', () => {
    // A cloud thermostat whose minimum is 7 °C: Homey stores PELS's 5 °C, the
    // post-write refresh reads it back, and the next cloud poll reports 7 °C.
    // Every poll is confirmed, then moved, and PELS sets 5 °C again.
    for (const pollMs of [5 * MINUTE_MS, CONTEST_SETTLE_MS - 1]) {
      const { contests, journalled } = controlContestsForTest();
      for (let atMs = 0; atMs <= 4 * 60 * MINUTE_MS; atMs += pollMs) {
        contests.commandSent(sent(atMs, 5, atMs === 0 ? 20 : 7));
        contests.commandConfirmed(DEVICE, 'temperature', 5, atMs + 5_000);
      }
      expect(contests.contestedControl(DEVICE, 4 * 60 * MINUTE_MS)).toBeUndefined();
      expect(journalled).toEqual([]);
    }
  });

  it('counts a move once the device has read the value for the settle', () => {
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, 5, 20));
    contests.commandConfirmed(DEVICE, 'temperature', 5, MINUTE_MS);
    for (let round = 1; round <= 4; round += 1) {
      const confirmedAtMs = (round - 1) * ROUND_MS + MINUTE_MS;
      contests.commandSent(sent(confirmedAtMs + CONTEST_SETTLE_MS, 5, 22));
      contests.commandConfirmed(DEVICE, 'temperature', 5, round * ROUND_MS + MINUTE_MS);
    }
    expect(contests.contestedControl(DEVICE, 80 * MINUTE_MS)?.count).toBe(4);
  });

  it('settles from the send when the confirming report is dated before it', () => {
    // Three rounds, the last confirmed at 60 min; the send at 70 min is too soon to be a fourth.
    const { contests } = contestRounds(3, () => 22);
    contests.commandSent(sent(70 * MINUTE_MS, 5, 22));
    // A report from before the send says nothing about how long the device has kept it since.
    contests.commandConfirmed(DEVICE, 'temperature', 5, 50 * MINUTE_MS);
    contests.commandSent(sent(80 * MINUTE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 80 * MINUTE_MS)).toBeUndefined();
  });

  it('settles from the first confirmation after a send, not a later one', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.commandSent(sent(70 * MINUTE_MS, 5, 22));
    contests.commandConfirmed(DEVICE, 'temperature', 5, 70 * MINUTE_MS);
    contests.commandConfirmed(DEVICE, 'temperature', 5, 80 * MINUTE_MS);
    contests.commandSent(sent(70 * MINUTE_MS + CONTEST_SETTLE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 90 * MINUTE_MS)?.count).toBe(4);
  });

  it('says reverted while every round went back to the value from before PELS asked', () => {
    expect(contestRounds(4, () => 20).contests.contestedControl(DEVICE, 80 * MINUTE_MS)?.kind).toBe('reverted');
    expect(contestRounds(4, (round) => (round === 2 ? 22 : 20)).contests
      .contestedControl(DEVICE, 80 * MINUTE_MS)?.kind).toBe('overridden');
  });

  it('says overridden for on/off, whose earlier value says nothing about what moved it', () => {
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, false, true, 'on_off'));
    contests.commandConfirmed(DEVICE, 'on_off', false, 0);
    for (let round = 1; round <= 4; round += 1) {
      contests.commandSent(sent(round * ROUND_MS, false, true, 'on_off'));
      contests.commandConfirmed(DEVICE, 'on_off', false, round * ROUND_MS);
    }
    expect(contests.contestedControl(DEVICE, 4 * ROUND_MS)).toEqual({
      setting: 'on_off', kind: 'overridden', count: 4, sinceMs: ROUND_MS,
    });
  });

  it('counts a correction that did not stick once, not again on its retries', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.commandSent(sent(80 * MINUTE_MS, 5, 22));
    contests.commandSent(sent(82 * MINUTE_MS, 5, 22));
    contests.commandSent(sent(87 * MINUTE_MS, 5, 22));
    contests.commandSent(sent(102 * MINUTE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 102 * MINUTE_MS)?.count).toBe(4);
  });

  it('is no round when the device already reads the value, or reads nothing', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.commandSent(sent(80 * MINUTE_MS, 5, 5));
    contests.commandConfirmed(DEVICE, 'temperature', 5, 80 * MINUTE_MS);
    contests.commandSent(sent(100 * MINUTE_MS, 5, undefined));
    expect(contests.contestedControl(DEVICE, 100 * MINUTE_MS)).toBeUndefined();
  });

  it('forgets a command the plan no longer asks for, so asking again is a new command', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.retainPlanned('main', new Map([[DEVICE, { temperature: 21, on_off: null, level: null }]]));
    contests.commandSent(sent(80 * MINUTE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 80 * MINUTE_MS)).toBeUndefined();
  });

  it('keeps the command the plan still asks for', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.retainPlanned('main', new Map([[DEVICE, { temperature: 5, on_off: null, level: null }]]));
    contests.commandSent(sent(80 * MINUTE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 80 * MINUTE_MS)?.count).toBe(4);
  });

  it('forgets the commands of a device that left its home\'s plan, and only that home\'s', () => {
    const { contests } = contestRounds(3, () => 22);
    // A meter area's device, which the Main home's plan never holds.
    const areaHeater = { ...sent(0, 5, 20), homeId: 'area', deviceId: 'annex' };
    contests.commandSent(areaHeater);
    contests.commandConfirmed('annex', 'temperature', 5, 0);
    for (let round = 1; round <= 3; round += 1) {
      contests.commandSent({ ...areaHeater, observed: 22, atMs: round * ROUND_MS });
      contests.commandConfirmed('annex', 'temperature', 5, round * ROUND_MS);
    }

    // Main's plan no longer holds the device (its owner stopped managing it).
    contests.retainPlanned('main', new Map());
    contests.commandSent(sent(80 * MINUTE_MS, 5, 22));
    contests.commandSent({ ...areaHeater, observed: 22, atMs: 80 * MINUTE_MS });
    expect(contests.contestedControl(DEVICE, 80 * MINUTE_MS)).toBeUndefined();
    expect(contests.contestedControl('annex', 80 * MINUTE_MS)?.count).toBe(4);
  });

  it('forgets a command whose session ended', () => {
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, 'max', 'low', 'level'));
    contests.commandConfirmed(DEVICE, 'level', 'max', 0);
    contests.commandReleased(DEVICE, 'level');
    for (let round = 1; round <= 4; round += 1) contests.commandSent(sent(round * ROUND_MS, 'max', 'low', 'level'));
    expect(contests.contestedControl(DEVICE, 4 * ROUND_MS)).toBeUndefined();
  });

  it('lets rounds older than 2 hours go', () => {
    const { contests } = contestRounds(4, () => 22);
    expect(contests.contestedControl(DEVICE, 2 * 60 * MINUTE_MS)?.count).toBe(4);
    expect(contests.contestedControl(DEVICE, ROUND_MS + CONTEST_WINDOW_MS)).toBeUndefined();
  });

  it('keeps when a contest began while it runs on, and a later contest begins anew', () => {
    const { contests } = contestRounds(10, () => 22);
    // Rounds every 20 minutes from 20 to 200: the window now holds 100 to 200.
    expect(contests.contestedControl(DEVICE, 200 * MINUTE_MS)).toMatchObject({ count: 6, sinceMs: ROUND_MS });

    // Quiet for 2 hours, so that contest ended; four more rounds make a new one.
    const resumedAtMs = 200 * MINUTE_MS + CONTEST_WINDOW_MS;
    for (let round = 0; round < 4; round += 1) {
      contests.commandSent(sent(resumedAtMs + round * ROUND_MS, 5, 22));
      contests.commandConfirmed(DEVICE, 'temperature', 5, resumedAtMs + round * ROUND_MS);
      if (round < 3) expect(contests.contestedControl(DEVICE, resumedAtMs + round * ROUND_MS)).toBeUndefined();
    }
    expect(contests.contestedControl(DEVICE, resumedAtMs + 3 * ROUND_MS)).toMatchObject({
      count: 4, sinceMs: resumedAtMs,
    });
  });

  it('needs the four rounds within 2 hours, not spread over a longer stretch', () => {
    const { contests, journalled } = contestRounds(6, () => 22, 45 * MINUTE_MS);
    expect(contests.contestedControl(DEVICE, 6 * 45 * MINUTE_MS)).toBeUndefined();
    expect(journalled).toEqual([]);
  });

  it('counts each setting on its own', () => {
    const { contests } = controlContestsForTest();
    for (const setting of ['temperature', 'on_off'] as const) {
      const value = setting === 'temperature' ? 5 : false;
      contests.commandSent(sent(0, value, setting === 'temperature' ? 20 : true, setting));
      contests.commandConfirmed(DEVICE, setting, value, 0);
    }
    for (let round = 1; round <= 2; round += 1) {
      contests.commandSent(sent(round * ROUND_MS, 5, 22));
      contests.commandConfirmed(DEVICE, 'temperature', 5, round * ROUND_MS);
      contests.commandSent(sent(round * ROUND_MS, false, true, 'on_off'));
      contests.commandConfirmed(DEVICE, 'on_off', false, round * ROUND_MS);
    }
    expect(contests.contestedControl(DEVICE, 3 * ROUND_MS)).toBeUndefined();
  });
});
