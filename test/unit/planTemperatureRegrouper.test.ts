import { withTemperatureDiscriminant } from '../../lib/plan/planTypes';

// The temperature twin of `planBinaryDevice.test.ts`: the regrouper is
// discriminated on `deviceType === 'temperature'` (the exact
// `isTemperaturePlanDevice` predicate) and moves the trio as ONE cluster —
// attached in full for a temperature device, stripped entirely otherwise. This
// is what keeps a stale cluster a `{ ...spread }` dragged in from surviving
// onto a demoted device, and what keeps the discriminant and the cluster from
// drifting apart at a construction/merge site.
describe('withTemperatureDiscriminant (deviceType = temperature status)', () => {
  it('attaches the complete trio for a temperature device', () => {
    const out = withTemperatureDiscriminant({
      id: 'a',
      deviceType: 'temperature' as const,
      currentTarget: 21,
      currentTemperature: 20.4,
      plannedTarget: 22,
    });
    expect(out).toMatchObject({
      currentTarget: 21,
      currentTemperature: 20.4,
      plannedTarget: 22,
    });
  });

  it('strips a stale spread-carried cluster off a non-temperature device', () => {
    // The demotion shape: a merge spread the OLD device (with its cluster) but
    // the fresh discriminant says onoff. The cluster must not survive.
    const out = withTemperatureDiscriminant({
      id: 'a',
      deviceType: 'onoff' as const,
      currentTarget: 21,
      currentTemperature: 20.4,
      plannedTarget: 22,
    });
    expect('currentTarget' in out).toBe(false);
    expect('currentTemperature' in out).toBe(false);
    expect('plannedTarget' in out).toBe(false);
  });

  it('strips the cluster when the bag carries no deviceType at all', () => {
    const out = withTemperatureDiscriminant({ id: 'a', currentTarget: 21 });
    expect('currentTarget' in out).toBe(false);
  });
});
