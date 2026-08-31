import { describe, expect, it } from 'vitest';
import { resolveSoleCumulativeMeter } from '../../lib/device/managerEnergy';

// The one census the explicit-meter world keeps (the boot-time
// meter-authority migration's detection): exactly one usable cumulative
// meter, carrying an id PELS can persist. Anything else is unresolvable,
// split by verdict: decisive shapes (ambiguous, id-less sole) may conclude a
// Flow demotion once confirmed; an empty/warming report is retryable and
// must never seal a permanent answer.
describe('resolveSoleCumulativeMeter', () => {
  it('resolves the sole finite id-bearing cumulative reading', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'device', id: 'charger', values: { W: 7_000 } },
        { type: 'cumulative', id: 'han', values: { W: 2_400 } },
      ],
    })).toEqual({ state: 'resolved', meterDeviceId: 'han' });
  });

  it('is unresolvable with several usable cumulative meters — no guessing', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', id: 'han', values: { W: 2_400 } },
        { type: 'cumulative', id: 'sub', values: { W: 900 } },
      ],
    })).toEqual({ state: 'unresolvable', verdict: 'decisive', reason: 'ambiguous' });
  });

  it('is unresolvable for a sole id-less aggregate — nothing nameable to persist', () => {
    expect(resolveSoleCumulativeMeter({
      items: [{ type: 'cumulative', values: { W: 640 } }],
    })).toEqual({ state: 'unresolvable', verdict: 'decisive', reason: 'idless_sole' });
    // An empty id normalizes to id-less.
    expect(resolveSoleCumulativeMeter({
      items: [{ type: 'cumulative', id: '', values: { W: 640 } }],
    })).toEqual({ state: 'unresolvable', verdict: 'decisive', reason: 'idless_sole' });
  });

  it('an id-less aggregate beside an id-bearing meter still makes two candidates', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', values: { W: 640 } },
        { type: 'cumulative', id: 'han', values: { W: 2_400 } },
      ],
    })).toEqual({ state: 'unresolvable', verdict: 'decisive', reason: 'ambiguous' });
  });

  it('ignores non-finite cumulative readings when counting usable candidates', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', id: 'broken', values: { W: Number.NaN } },
        { type: 'cumulative', id: 'han', values: { W: 2_400 } },
      ],
    })).toEqual({ state: 'resolved', meterDeviceId: 'han' });
  });

  it('deduplicates repeated rows for one id before deciding', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', id: 'han', values: { W: 2_400 } },
        { type: 'cumulative', id: 'han', values: { W: 2_500 } },
      ],
    })).toEqual({ state: 'resolved', meterDeviceId: 'han' });
  });

  it('is retryably unresolvable for missing, malformed, and unreadable reports — the warming shape', () => {
    const retryable = { state: 'unresolvable', verdict: 'retryable', reason: 'none_found' };
    expect(resolveSoleCumulativeMeter(null)).toEqual(retryable);
    expect(resolveSoleCumulativeMeter('nope')).toEqual(retryable);
    expect(resolveSoleCumulativeMeter({ items: 'nope' })).toEqual(retryable);
    expect(resolveSoleCumulativeMeter({ items: [] })).toEqual(retryable);
    // A meter that has not published finite watts yet is warming, not absent.
    expect(resolveSoleCumulativeMeter({
      items: [{ type: 'cumulative', id: 'han', values: {} }],
    })).toEqual(retryable);
  });
});
