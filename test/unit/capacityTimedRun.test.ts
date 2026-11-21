import { describe, expect, it } from 'vitest';
import {
  describeTimedRunChange,
  resolveCapacityTimedRun,
  type CapacityTimedRunInput,
} from '../../lib/plan/capacityTimedRun';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';

const NOW = Date.UTC(2026, 10, 15, 7, 0, 0);
const MIN = 60_000;
// 5 kW with a 0.3 kW margin: a 4.7 kWh hour, and a reserve of 0.15 kW for the time left.
const settings: CapacitySettings = { limitKw: 5, marginKw: 0.3, periodMinutes: 60 };

const heater = (id: string, priority: number, kw: number, on: boolean) => buildPlanInputDevice({
  id, name: id, priority, binaryControl: { on }, currentDrawKw: on ? kw : 0, expectedPowerKw: kw,
});

const frame = (overrides: Partial<CapacityTimedRunInput>): CapacityTimedRunInput => ({
  settings,
  paceKw: 4.7,
  shortfallThresholdKw: 10,
  usedKWh: 0,
  budgetKWh: 4.7,
  minutesRemaining: 60,
  coverageComplete: true,
  drawKw: 4.28,
  timedStartDraw: { kind: 'projected', outstandingRestoreKw: 0 },
  devices: [heater('small', 1, 0.5, true), heater('mid', 2, 0.8, false)],
  heldOffIds: new Set(['mid']),
  forceShedIds: new Set(),
  nowMs: NOW,
  ...overrides,
});

describe('resolveCapacityTimedRun', () => {
  it('starts a held-off heater at :00 for as long as the hour covers the house after it stops', () => {
    // 4.7 − 0.15 reserve − 4.28 kWh for the house = 0.27 kWh: 20.25 minutes of
    // 0.8 kW, less the 2 minutes it may take to stop.
    const run = resolveCapacityTimedRun(frame({}));
    expect(run).toMatchObject({ kind: 'start', deviceId: 'mid', deviceKw: 0.8 });
    if (run.kind === 'none') throw new Error('expected a run');
    expect((run.stopAtMs - NOW) / MIN).toBeCloseTo(18.25, 6);
    // Its draw plus its restore buffer fits under the raised pace.
    expect(run.allowedKw).toBeCloseTo(4.28 + 0.8 + 0.2, 6);
  });

  it('does not start a timed run while a binary restore is unconfirmed', () => {
    expect(resolveCapacityTimedRun(frame({
      timedStartDraw: { kind: 'command_in_flight' },
    }))).toEqual({ kind: 'none' });
  });

  it('charges outstanding restore draw to start safety and duration without raising the pace', () => {
    const blocked = resolveCapacityTimedRun(frame({
      timedStartDraw: { kind: 'projected', outstandingRestoreKw: 0.5 },
    }));
    expect(blocked).toEqual({ kind: 'none' });
    const hardCapBlocked = resolveCapacityTimedRun(frame({
      shortfallThresholdKw: 5.5,
      timedStartDraw: { kind: 'projected', outstandingRestoreKw: 0.1 },
    }));
    expect(hardCapBlocked).toEqual({ kind: 'none' });
    const run = resolveCapacityTimedRun(frame({
      timedStartDraw: { kind: 'projected', outstandingRestoreKw: 0.1 },
    }));
    expect(run).toMatchObject({ kind: 'start', allowedKw: 5.28 });
    if (run.kind === 'none') throw new Error('expected a run');
    expect((run.stopAtMs - NOW) / MIN).toBeCloseTo(10.75, 6);
  });

  it('keeps a timed run when reserved restore draw larger than the start buffer arrives', () => {
    const usedKWh = 4.7 - 5.3 * 30 / 60;
    const initial = frame({
      drawKw: 4.36,
      paceKw: 5.3,
      usedKWh,
      minutesRemaining: 30,
      shortfallThresholdKw: 5.9,
      timedStartDraw: { kind: 'projected', outstandingRestoreKw: 0.22 },
    });
    const start = resolveCapacityTimedRun(initial);
    expect(start).toMatchObject({ kind: 'start', deviceId: 'mid' });
    if (start.kind === 'none') throw new Error('expected a run');
    expect(start.allowedKw).toBeCloseTo(5.36);
    // Both increases have arrived. The next build recalculates keep from the
    // measured draw against the ordinary pace, even above the old start pace.
    expect(resolveCapacityTimedRun({
      ...initial,
      drawKw: 5.38,
      devices: [heater('small', 1, 0.8, true), heater('mid', 2, 0.8, true)],
      heldOffIds: new Set(),
      timedStartDraw: { kind: 'command_in_flight' },
    })).toMatchObject({ kind: 'keep', deviceId: 'mid', allowedKw: 5.38 });
  });

  it('keeps the running heater over the pace and stops it when the hour runs out', () => {
    // Ten minutes in at 5.08 kW, house without the heater at 4.28 kW.
    const usedKWh = 5.08 * 10 / 60;
    const paceKw = (4.7 - usedKWh) / (50 / 60);
    const running = [heater('small', 1, 0.5, true), heater('mid', 2, 0.8, true)];
    const run = resolveCapacityTimedRun(frame({
      usedKWh, paceKw, minutesRemaining: 50, drawKw: 5.08, devices: running, heldOffIds: new Set(),
      nowMs: NOW + 10 * MIN,
    }));
    expect(run).toMatchObject({ kind: 'keep', deviceId: 'mid', allowedKw: 5.08 });
    if (run.kind === 'none') throw new Error('expected a run');
    const spare = 4.7 - usedKWh - 0.15 * (50 / 60) - 4.28 * (50 / 60);
    expect((run.stopAtMs - NOW - 10 * MIN) / MIN).toBeCloseTo(spare / 0.8 * 60 - 2, 6);

    // Once the spare energy is gone, the pace is the ordinary one again.
    const spent = 4.7 - 0.15 * (30 / 60) - 4.28 * (30 / 60) + 0.01;
    expect(resolveCapacityTimedRun(frame({
      usedKWh: spent, paceKw: (4.7 - spent) / 0.5, minutesRemaining: 30, drawKw: 5.08, devices: running,
    }))).toEqual({ kind: 'none' });
  });

  it('keeps the lowest-priority running device and starts the highest-priority held-off one', () => {
    // The house is 0.2 kW over its pace; without the lowest-priority heater it is 4.3 kW.
    const keep = resolveCapacityTimedRun(frame({
      drawKw: 4.9,
      devices: [heater('a', 1, 0.8, true), heater('b', 3, 0.6, true), heater('c', 2, 0.7, true)],
      heldOffIds: new Set(),
    }));
    expect(keep).toMatchObject({ kind: 'keep', deviceId: 'b' });
    // 4.1 kW plus a 0.5 kW heater and its buffer is over the 4.7 kW pace.
    const start = resolveCapacityTimedRun(frame({
      drawKw: 4.1,
      devices: [heater('a', 3, 0.5, false), heater('b', 2, 0.5, false), heater('c', 4, 0.5, false)],
      heldOffIds: new Set(['a', 'b', 'c']),
    }));
    expect(start).toMatchObject({ kind: 'start', deviceId: 'b' });
  });

  it('ends every run before the drain, and runs none inside it', () => {
    // 0.2 kWh spare covers 13 minutes of 0.8 kW after its stop; the drain starts in 10.
    const run = resolveCapacityTimedRun(frame({ drawKw: 3, minutesRemaining: 20, usedKWh: 3.45, paceKw: 3.75 }));
    if (run.kind === 'none') throw new Error('expected a run');
    expect((run.stopAtMs - NOW) / MIN).toBeCloseTo(10, 6);
    expect(resolveCapacityTimedRun(frame({ minutesRemaining: 10, drawKw: 2, usedKWh: 3 }))).toEqual({ kind: 'none' });
  });

  it('starts nothing for less than ten minutes', () => {
    // 0.1 kWh spare is 7.5 minutes of 0.8 kW.
    expect(resolveCapacityTimedRun(frame({ drawKw: 4.45 }))).toEqual({ kind: 'none' });
    // Plenty spare, but the drain starts in 8 minutes.
    expect(resolveCapacityTimedRun(frame({ drawKw: 3, minutesRemaining: 18, usedKWh: 3, paceKw: 5.6 })))
      .toEqual({ kind: 'none' });
  });

  it('keeps nothing the last plan limited, while its command lands', () => {
    expect(resolveCapacityTimedRun(frame({
      drawKw: 4.9, devices: [heater('mid', 2, 0.8, true)], heldOffIds: new Set(['mid']),
    }))).toEqual({ kind: 'none' });
  });

  it('keeps nothing whose own reading is above the whole house', () => {
    expect(resolveCapacityTimedRun(frame({
      drawKw: 4.75, devices: [heater('mid', 2, 5, true)], heldOffIds: new Set(),
    }))).toEqual({ kind: 'none' });
  });

  it('runs nothing in a quarter, before the hour is fully sampled, or when the pace already fits', () => {
    expect(resolveCapacityTimedRun(frame({ settings: { ...settings, periodMinutes: 15 } }))).toEqual({ kind: 'none' });
    expect(resolveCapacityTimedRun(frame({ coverageComplete: false }))).toEqual({ kind: 'none' });
    expect(resolveCapacityTimedRun(frame({ paceKw: 6 }))).toEqual({ kind: 'none' });
  });

  it('keeps nothing that limiting alone would not bring under the pace, or past the hard cap', () => {
    const running = { devices: [heater('mid', 2, 0.8, true)], heldOffIds: new Set<string>() };
    expect(resolveCapacityTimedRun(frame({ drawKw: 5.6, ...running }))).toEqual({ kind: 'none' });
    expect(resolveCapacityTimedRun(frame({ drawKw: 4.9, ...running }))).toMatchObject({ kind: 'keep' });
  });

  it('holds a draw past the pace only while, held to :00, it leaves half the margin under the hard cap', () => {
    const running = { devices: [heater('mid', 2, 0.8, true)], heldOffIds: new Set<string>() };
    // 0.15 kWh of the 0.3 kWh margin must stay under the hard cap at the held draw.
    expect(resolveCapacityTimedRun(frame({ drawKw: 4.9, shortfallThresholdKw: 5.06, ...running })))
      .toMatchObject({ kind: 'keep' });
    expect(resolveCapacityTimedRun(frame({ drawKw: 4.9, shortfallThresholdKw: 5.04, ...running })))
      .toEqual({ kind: 'none' });
    // A start is judged at the draw it would reach plus its restore buffer:
    // 4.28 + 0.8 + 0.2 kW (5.43 kW leaves exactly 0.15 kWh), so the keep that
    // follows has 0.2 kW of room.
    expect(resolveCapacityTimedRun(frame({ shortfallThresholdKw: 5.44 }))).toMatchObject({ kind: 'start' });
    expect(resolveCapacityTimedRun(frame({ shortfallThresholdKw: 5.42 }))).toEqual({ kind: 'none' });
  });

  it('keeps a device it only just started when the next reading is a little higher', () => {
    const shortfallThresholdKw = 5.44;
    expect(resolveCapacityTimedRun(frame({ shortfallThresholdKw }))).toMatchObject({ kind: 'start' });
    // Started: the heater draws, and the background is 0.15 kW up on the next reading.
    expect(resolveCapacityTimedRun(frame({
      shortfallThresholdKw, drawKw: 4.28 + 0.8 + 0.15, devices: [heater('small', 1, 0.5, true), heater('mid', 2, 0.8, true)],
      heldOffIds: new Set(),
    }))).toMatchObject({ kind: 'keep', deviceId: 'mid' });
  });

  it('runs nothing past a lower-ranked device that is not on/off', () => {
    const charger = buildPlanInputDevice({ id: 'ev', priority: 9, isEvCharger: true, currentDrawKw: 1.4, expectedPowerKw: 1.4 });
    expect(resolveCapacityTimedRun(frame({
      drawKw: 4.9, devices: [heater('mid', 2, 0.8, true), charger], heldOffIds: new Set(),
    }))).toEqual({ kind: 'none' });
    const waiting = buildPlanInputDevice({ id: 'ev', priority: 1, isEvCharger: true, currentDrawKw: 0, expectedPowerKw: 1.4 });
    expect(resolveCapacityTimedRun(frame({
      devices: [waiting, heater('mid', 2, 0.8, false)], heldOffIds: new Set(['ev', 'mid']),
    }))).toEqual({ kind: 'none' });
  });

  it('leaves stepped, EV, smart-task-held and owner-switched-off devices alone', () => {
    const stepped = buildPlanInputDevice({
      id: 'mid', priority: 2, currentDrawKw: 0,
      steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'on', planningPowerW: 800 }] },
      selectedStepId: 'off',
    });
    expect(resolveCapacityTimedRun(frame({ devices: [stepped] }))).toEqual({ kind: 'none' });
    const ev = buildPlanInputDevice({ id: 'mid', priority: 2, isEvCharger: true, binaryControl: { on: false }, expectedPowerKw: 1.4 });
    expect(resolveCapacityTimedRun(frame({ devices: [ev] }))).toEqual({ kind: 'none' });
    expect(resolveCapacityTimedRun(frame({ forceShedIds: new Set(['mid']) }))).toEqual({ kind: 'none' });
    expect(resolveCapacityTimedRun(frame({ heldOffIds: new Set() }))).toEqual({ kind: 'none' });
  });
});

describe('describeTimedRunChange', () => {
  it('describes a start, a move and an end once each', () => {
    const run = resolveCapacityTimedRun(frame({}));
    expect(describeTimedRunChange(null, run)).toMatchObject({ event: 'capacity_timed_run_started', deviceId: 'mid' });
    expect(describeTimedRunChange('mid', run)).toBeNull();
    expect(describeTimedRunChange('other', run)).toMatchObject({ event: 'capacity_timed_run_started' });
    expect(describeTimedRunChange('mid', { kind: 'none' })).toEqual({ event: 'capacity_timed_run_ended', deviceId: 'mid' });
    expect(describeTimedRunChange(null, { kind: 'none' })).toBeNull();
  });
});
