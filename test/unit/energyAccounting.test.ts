import { EnergyAccounting } from '../../lib/power/energyAccounting';

const key = '2026-11-02T21:00:00.000Z';

describe('energy accounting', () => {
  it('excludes a capacity-off task from budget usage and both background learning views', () => {
    const accounting = new EnergyAccounting({
      buckets: { [key]: 4.4 },
      controlledBuckets: { [key]: 0.4 },
      uncontrolledBuckets: { [key]: 4 },
      exemptBuckets: { [key]: 3.06 },
      uncontrolledExemptBuckets: { [key]: 3.06 },
    });
    const hour = accounting.bucket(key);
    expect(hour.meteredKwh).toBe(4.4);
    expect(hour.actual).toEqual({ controlled: 0.4, background: 4 });
    expect(hour.budgetCountedKwh).toBeCloseTo(1.34);
    expect(hour.counted.controlled).toBeCloseTo(0.4);
    expect(hour.counted.background).toBeCloseTo(0.94);
    expect(hour.countedGross.background).toBeCloseTo(0.94);
    const window = accounting.window([Date.parse(key)]);
    expect(window.budgetControlUsedNowKWh).toBeCloseTo(1.34);
    expect(window.meteredUsedNowKWh).toBe(4.4);
    expect(window.exemptUsedNowKWh).toBe(3.06);
  });

  it('removes the managed and background exempt portions from their own gross sides under PV', () => {
    const hour = new EnergyAccounting({
      buckets: { [key]: 2 },
      controlledBuckets: { [key]: 3 },
      uncontrolledBuckets: { [key]: 4 },
      exemptBuckets: { [key]: 4 },
      uncontrolledExemptBuckets: { [key]: 3 },
    }).bucket(key);
    expect(hour.actual).toEqual({ controlled: 3, background: 4 });
    expect(hour.countedGross).toEqual({ controlled: 2, background: 1 });
    expect(hour.exemptKwh).toBe(2);
    expect(hour.budgetCountedKwh).toBe(0);
    expect(hour.counted).toEqual({ controlled: 0, background: 0 });
  });

  it('interprets legacy recorded exemption as managed-only without moving it to background', () => {
    const hour = new EnergyAccounting({
      buckets: { [key]: 4 },
      controlledBuckets: { [key]: 3 },
      exemptBuckets: { [key]: 1.5 },
    }).bucket(key);
    expect(hour.counted).toEqual({ controlled: 1.5, background: 1 });
    expect(hour.countedGross).toEqual({ controlled: 1.5, background: 1 });
  });

  it('does not call an unmeasured day complete or confuse a measured zero with absence', () => {
    const buckets = Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [
      new Date(Date.UTC(2026, 10, 2, hour)).toISOString(), 0,
    ]));
    expect(new EnergyAccounting({ buckets }).budgetCountedDay('2026-11-02', 'UTC')).toBe(0);
    const { [key]: _missing, ...incomplete } = buckets;
    expect(new EnergyAccounting({ buckets: incomplete }).budgetCountedDay('2026-11-02', 'UTC')).toBeUndefined();
  });
});
