import { describe, expect, it } from 'vitest';
import {
  SOLAR_PRODUCING_FROM_W,
  SOLAR_STOPPED_BELOW_W,
  SOLAR_STOPPED_HOLD_MS,
  SolarProductionPhase,
} from '../../lib/power/solarProductionPhase';

const MINUTE = 60_000;
const w = (watts: number) => ({ state: 'measured', watts } as const);
const NO_READING = { state: 'unavailable' } as const;
const NOTHING_GENERATES = { state: 'none' } as const;

describe('SolarProductionPhase', () => {
  it('is unknown until the feed carries a production reading', () => {
    const phase = new SolarProductionPhase();
    expect(phase.read()).toBe('unknown');
    phase.observe(NO_READING, 0);
    phase.observe(NO_READING, 60 * MINUTE);
    expect(phase.read()).toBe('unknown');
  });

  it('reads producing from the first reading at or above the stop level', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(SOLAR_STOPPED_BELOW_W), 0);
    expect(phase.read()).toBe('producing');
  });

  it('stays unknown while a first low reading has not held long enough', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(0), 0);
    expect(phase.read()).toBe('unknown');
    phase.observe(w(0), SOLAR_STOPPED_HOLD_MS);
    expect(phase.read()).toBe('not_producing');
  });

  it('counts the panels as stopped only after the hold below the stop level', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(1500), 0);
    phase.observe(w(40), MINUTE);
    phase.observe(w(30), MINUTE + SOLAR_STOPPED_HOLD_MS - 1);
    expect(phase.read()).toBe('producing');
    phase.observe(w(20), MINUTE + SOLAR_STOPPED_HOLD_MS);
    expect(phase.read()).toBe('not_producing');
  });

  it('restarts the hold when production comes back above the stop level', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(1500), 0);
    phase.observe(w(40), MINUTE);
    phase.observe(w(150), 6 * MINUTE);
    phase.observe(w(40), 7 * MINUTE);
    phase.observe(w(40), 7 * MINUTE + SOLAR_STOPPED_HOLD_MS - 1);
    expect(phase.read()).toBe('producing');
  });

  it('needs a clear return before it reads producing again', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(0), 0);
    phase.observe(w(0), SOLAR_STOPPED_HOLD_MS);
    expect(phase.read()).toBe('not_producing');
    phase.observe(w(SOLAR_PRODUCING_FROM_W - 1), SOLAR_STOPPED_HOLD_MS + MINUTE);
    expect(phase.read()).toBe('not_producing');
    phase.observe(w(SOLAR_PRODUCING_FROM_W), SOLAR_STOPPED_HOLD_MS + 2 * MINUTE);
    expect(phase.read()).toBe('producing');
  });

  it('keeps the last accepted reading through samples that carry none', () => {
    const producing = new SolarProductionPhase();
    producing.observe(w(2000), 0);
    producing.observe(NO_READING, 120 * MINUTE);
    expect(producing.read()).toBe('producing');

    // The feed last said "below the stop level", so the hold keeps running.
    const stopping = new SolarProductionPhase();
    stopping.observe(w(2000), 0);
    stopping.observe(w(10), MINUTE);
    stopping.observe(NO_READING, MINUTE + SOLAR_STOPPED_HOLD_MS);
    expect(stopping.read()).toBe('not_producing');
  });

  it('ignores a non-finite reading', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(Number.NaN), 0);
    expect(phase.read()).toBe('unknown');
  });

  it('restarts the hold when the clock steps back', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(2000), 0);
    phase.observe(w(10), 100 * MINUTE);
    phase.observe(w(10), 50 * MINUTE);
    phase.observe(w(10), 50 * MINUTE + SOLAR_STOPPED_HOLD_MS - 1);
    expect(phase.read()).toBe('producing');
    phase.observe(w(10), 50 * MINUTE + SOLAR_STOPPED_HOLD_MS);
    expect(phase.read()).toBe('not_producing');
  });

  it('counts Homey reporting that nothing generates as stopped, once the panels have reported watts', () => {
    const phase = new SolarProductionPhase();
    phase.observe(w(2500), 0);
    phase.observe(NOTHING_GENERATES, MINUTE);
    phase.observe(NOTHING_GENERATES, MINUTE + SOLAR_STOPPED_HOLD_MS - 1);
    expect(phase.read()).toBe('producing');
    phase.observe(NOTHING_GENERATES, MINUTE + SOLAR_STOPPED_HOLD_MS);
    expect(phase.read()).toBe('not_producing');
  });

  it('learns nothing from "nothing generates" before any watts: a meter-only solar home always says it', () => {
    const phase = new SolarProductionPhase();
    phase.observe(NOTHING_GENERATES, 0);
    phase.observe(NOTHING_GENERATES, 2 * SOLAR_STOPPED_HOLD_MS);
    expect(phase.read()).toBe('unknown');
  });
});
