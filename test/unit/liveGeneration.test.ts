import { describe, expect, it } from 'vitest';
import { asLiveEnergyReport, resolveLiveGeneration } from '../../lib/device/managerEnergy';

describe('asLiveEnergyReport', () => {
  it('accepts only a record carrying an items array', () => {
    expect(asLiveEnergyReport({ items: [] })).toEqual({ items: [] });
    expect(asLiveEnergyReport({ items: [], totalGenerated: { W: 1 } })).not.toBeNull();
  });

  it('rejects an empty body, a non-object, and a record without items', () => {
    expect(asLiveEnergyReport(undefined)).toBeNull();
    expect(asLiveEnergyReport('')).toBeNull();
    expect(asLiveEnergyReport(42)).toBeNull();
    expect(asLiveEnergyReport({})).toBeNull();
    expect(asLiveEnergyReport({ items: 'nope' })).toBeNull();
  });
});

describe('resolveLiveGeneration', () => {
  it('prefers the top-level totalGenerated aggregate', () => {
    expect(resolveLiveGeneration({
      totalGenerated: { W: 600 },
      items: [{ type: 'generator', id: 'pv', values: { W: 900 } }],
    })).toEqual({ state: 'measured', watts: 600 });
  });

  it('falls back to the first generator item with finite watts', () => {
    expect(resolveLiveGeneration({
      items: [
        { type: 'generator', id: 'pv-a', values: { W: Number.NaN } },
        { type: 'generator', id: 'pv-b', values: { W: 900 } },
      ],
    })).toEqual({ state: 'measured', watts: 900 });
  });

  it('floors a negative reading to zero — production is +-only', () => {
    expect(resolveLiveGeneration({ totalGenerated: { W: -50 }, items: [] })).toEqual({ state: 'measured', watts: 0 });
    expect(resolveLiveGeneration({ items: [{ type: 'generator', values: { W: -5 } }] }))
      .toEqual({ state: 'measured', watts: 0 });
  });

  it('reports none for a parsed report with no generation signal', () => {
    // Homey always emits the aggregate and encodes "nothing generates" as
    // `W: null` — the ordinary no-PV home, observed on production.
    expect(resolveLiveGeneration({ totalGenerated: { W: null, cost: null }, items: [] })).toEqual({ state: 'none' });
    expect(resolveLiveGeneration({ totalGenerated: {}, items: [] })).toEqual({ state: 'none' });
    expect(resolveLiveGeneration({ items: [] })).toEqual({ state: 'none' });
    expect(resolveLiveGeneration({ items: [{ type: 'device', values: { W: 5 } }] })).toEqual({ state: 'none' });
  });

  it('reports unavailable when a generation signal is present but every reading is malformed', () => {
    // A junk reading is a no-op, never a fresh "producing nothing": the held
    // reading carries forward (root AGENTS.md, transient external failure).
    expect(resolveLiveGeneration({ totalGenerated: { W: 'junk' }, items: [] })).toEqual({ state: 'unavailable' });
    expect(resolveLiveGeneration({ totalGenerated: { W: Number.NaN }, items: [] })).toEqual({ state: 'unavailable' });
    expect(resolveLiveGeneration({ items: [{ type: 'generator', id: 'pv', values: { W: Number.NaN } }] }))
      .toEqual({ state: 'unavailable' });
    expect(resolveLiveGeneration({ totalGenerated: { W: Number.POSITIVE_INFINITY }, items: [{ type: 'generator', values: {} }] }))
      .toEqual({ state: 'unavailable' });
  });
});
