import { describe, expect, it } from 'vitest';
import type { ContestedSetting } from '../../packages/contracts/src/controlContest';
import type { ControlValue } from '../../lib/executor/controlContest';
import { CONTEST_WINDOW_MS } from '../../lib/executor/controlContest';
import { controlContestsForTest } from '../helpers/controlContests';

const MINUTE_MS = 60_000;
const DEVICE = 'mill';

const sent = (
  atMs: number,
  value: ControlValue,
  observed: ControlValue | undefined,
  setting: ContestedSetting = 'temperature',
) => ({ deviceId: DEVICE, deviceName: 'Gang nede ovn', setting, value, observed, atMs });

/** PELS asks for 5 °C over 20 °C and the device confirms; then `moves` rounds of `drifted`, each set back and confirmed. */
const contestRounds = (moves: number, drifted: (round: number) => ControlValue, everyMs = 10 * MINUTE_MS) => {
  const record = controlContestsForTest();
  record.contests.commandSent(sent(0, 5, 20));
  record.contests.commandConfirmed(DEVICE, 'temperature', 5);
  for (let round = 1; round <= moves; round += 1) {
    record.contests.commandSent(sent(round * everyMs, 5, drifted(round)));
    record.contests.commandConfirmed(DEVICE, 'temperature', 5);
  }
  return record;
};

describe('ControlContestRecord', () => {
  it('never counts the retries of a command the device did not confirm', () => {
    // A thermostat that clamps 5 °C to 7 °C: PELS retries on its ladder for hours.
    const { contests, journalled } = controlContestsForTest();
    contests.commandSent(sent(0, 5, 20));
    for (let retry = 1; retry <= 12; retry += 1) contests.commandSent(sent(retry * 15 * MINUTE_MS, 5, 7));
    expect(contests.contestedControl(DEVICE, 3 * 60 * MINUTE_MS)).toBeUndefined();
    expect(journalled).toEqual([]);
  });

  it('counts a confirmed setting that something moves away four times in an hour, and reports it once', () => {
    const { contests, journalled } = contestRounds(5, () => 22);
    expect(contests.contestedControl(DEVICE, 50 * MINUTE_MS)).toEqual({
      setting: 'temperature', kind: 'overridden', count: 5, sinceMs: 10 * MINUTE_MS,
    });
    expect(journalled).toHaveLength(1);
    expect(journalled[0]).toEqual({
      deviceIds: [DEVICE],
      event: expect.objectContaining({
        event: 'device_control_contested', deviceId: DEVICE, deviceName: 'Gang nede ovn', setting: 'temperature',
        kind: 'overridden', count: 4, firstAtMs: 10 * MINUTE_MS,
      }),
    });
  });

  it('says reverted while every round went back to the value from before PELS asked', () => {
    expect(contestRounds(4, () => 20).contests.contestedControl(DEVICE, 40 * MINUTE_MS)?.kind).toBe('reverted');
    expect(contestRounds(4, (round) => (round === 2 ? 22 : 20)).contests
      .contestedControl(DEVICE, 40 * MINUTE_MS)?.kind).toBe('overridden');
  });

  it('counts a correction that did not stick once, not again on its retries', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.commandSent(sent(40 * MINUTE_MS, 5, 22));
    contests.commandSent(sent(42 * MINUTE_MS, 5, 22));
    contests.commandSent(sent(47 * MINUTE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 47 * MINUTE_MS)?.count).toBe(4);
  });

  it('is no round when the device already reads the value, or reads nothing', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.commandSent(sent(40 * MINUTE_MS, 5, 5));
    contests.commandConfirmed(DEVICE, 'temperature', 5);
    contests.commandSent(sent(41 * MINUTE_MS, 5, undefined));
    expect(contests.contestedControl(DEVICE, 41 * MINUTE_MS)).toBeUndefined();
  });

  it('forgets a command the plan no longer asks for, so asking again is a new command', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.retainPlanned(DEVICE, { temperature: 21, on_off: null, level: null });
    contests.commandSent(sent(35 * MINUTE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 35 * MINUTE_MS)).toBeUndefined();
  });

  it('keeps the command the plan still asks for', () => {
    const { contests } = contestRounds(3, () => 22);
    contests.retainPlanned(DEVICE, { temperature: 5, on_off: null, level: null });
    contests.commandSent(sent(35 * MINUTE_MS, 5, 22));
    expect(contests.contestedControl(DEVICE, 35 * MINUTE_MS)?.count).toBe(4);
  });

  it('forgets a command whose session ended', () => {
    const { contests } = controlContestsForTest();
    contests.commandSent(sent(0, 'max', 'low', 'level'));
    contests.commandConfirmed(DEVICE, 'level', 'max');
    contests.commandReleased(DEVICE, 'level');
    for (let round = 1; round <= 4; round += 1) contests.commandSent(sent(round * MINUTE_MS, 'max', 'low', 'level'));
    expect(contests.contestedControl(DEVICE, 4 * MINUTE_MS)).toBeUndefined();
  });

  it('lets rounds older than the hour go', () => {
    const { contests } = contestRounds(4, () => 22, 15 * MINUTE_MS);
    expect(contests.contestedControl(DEVICE, 60 * MINUTE_MS)?.count).toBe(4);
    expect(contests.contestedControl(DEVICE, 15 * MINUTE_MS + CONTEST_WINDOW_MS)).toBeUndefined();
  });

  it('counts each setting on its own', () => {
    const { contests } = controlContestsForTest();
    for (const setting of ['temperature', 'on_off'] as const) {
      const value = setting === 'temperature' ? 5 : false;
      contests.commandSent(sent(0, value, setting === 'temperature' ? 20 : true, setting));
      contests.commandConfirmed(DEVICE, setting, value);
    }
    for (let round = 1; round <= 2; round += 1) {
      contests.commandSent(sent(round * MINUTE_MS, 5, 22));
      contests.commandConfirmed(DEVICE, 'temperature', 5);
      contests.commandSent(sent(round * MINUTE_MS, false, true, 'on_off'));
      contests.commandConfirmed(DEVICE, 'on_off', false);
    }
    expect(contests.contestedControl(DEVICE, 3 * MINUTE_MS)).toBeUndefined();
  });
});
