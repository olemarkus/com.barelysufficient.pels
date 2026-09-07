import { describe, expect, it } from 'vitest';
import {
  withBinaryDiscriminant,
  withSteppedDiscriminant,
  withTemperatureDiscriminant,
} from '../../lib/plan/planTypes';
import { steppedProfile } from '../utils/planTestUtils';

// The wrappers are a type seam. At runtime their only job is to strip a probe
// field a producer left behind; an object with nothing to strip is returned as
// is. That identity is what keeps a plan build from copying every device three
// extra times, so it is pinned here rather than left to whoever next reaches
// for a spread.
describe('discriminant wrappers return the object untouched when there is nothing to strip', () => {
  it('binary: a producer-resolved `currentOn` with no raw `binaryControl`', () => {
    const loose = { id: 'dev', currentOn: true };
    expect(withBinaryDiscriminant(loose)).toBe(loose);
    const neither = { id: 'dev' };
    expect(withBinaryDiscriminant(neither)).toBe(neither);
  });

  it('binary: a probe key present with `undefined` is still removed, as the copy path removed it', () => {
    // Key presence is what consumers read (`'currentOn' in dev`), so the fast
    // path must not keep a key the strip path would have dropped.
    const explicit = { id: 'dev', currentOn: undefined };
    expect(withBinaryDiscriminant(explicit)).not.toBe(explicit);
    expect('currentOn' in withBinaryDiscriminant(explicit)).toBe(false);
    expect('plannedTarget' in withTemperatureDiscriminant({ id: 'dev', plannedTarget: undefined })).toBe(false);
    expect('selectedStepId' in withSteppedDiscriminant({ id: 'dev', selectedStepId: undefined })).toBe(false);
  });

  it('binary: still strips a raw `binaryControl` a producer left behind', () => {
    const loose = { id: 'dev', binaryControl: { on: true }, currentOn: true };
    const regrouped = withBinaryDiscriminant(loose);
    expect(regrouped).not.toBe(loose);
    expect(regrouped).toEqual({ id: 'dev', currentOn: true });
  });

  it('temperature: a complete cluster, or none of it', () => {
    const thermostat = { id: 'dev', deviceType: 'temperature', currentTarget: 21, currentTemperature: 20, plannedTarget: 21 };
    expect(withTemperatureDiscriminant(thermostat)).toBe(thermostat);
    const plain = { id: 'dev' };
    expect(withTemperatureDiscriminant(plain)).toBe(plain);
  });

  it('temperature: still strips a stray partial cluster off a non-temperature object', () => {
    expect(withTemperatureDiscriminant({ id: 'dev', plannedTarget: 21 })).toEqual({ id: 'dev' });
    expect(withTemperatureDiscriminant({ id: 'dev', currentTemperature: 20 })).toEqual({ id: 'dev' });
    expect(withTemperatureDiscriminant({ id: 'dev', currentTarget: 21 })).toEqual({ id: 'dev' });
  });

  it('stepped: a profile keeps its trio; no trio is nothing to strip', () => {
    const stepped = { id: 'dev', steppedLoadProfile: steppedProfile, selectedStepId: 'max', planningPowerKw: 2.5 };
    expect(withSteppedDiscriminant(stepped)).toBe(stepped);
    const plain = { id: 'dev' };
    expect(withSteppedDiscriminant(plain)).toBe(plain);
  });

  it('stepped: still strips stray step fields off a non-stepped object', () => {
    expect(withSteppedDiscriminant({ id: 'dev', selectedStepId: 'max' })).toEqual({ id: 'dev' });
    expect(withSteppedDiscriminant({ id: 'dev', planningPowerKw: 1.2 })).toEqual({ id: 'dev' });
  });
});
