import { describe, expect, it } from 'vitest';
import {
  resolveRegistryMeterCandidates,
  resolveSoleCumulativeMeter,
  resolveSoleMeterAdoptionCandidate,
} from '../../lib/device/soleCumulativeMeter';

// The one census the explicit-meter world keeps (the boot-time sole-meter
// adoption's detection): exactly one usable cumulative meter, carrying an id
// PELS can persist. Anything else is unresolvable: ambiguous and id-less-sole
// shapes end the adoption's run for this boot with nothing named, while an
// empty/warming report is "not yet" and must never be read as an answer.
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
    })).toEqual({ state: 'unresolvable', reason: 'ambiguous' });
  });

  it('is unresolvable for a sole id-less aggregate — nothing nameable to persist', () => {
    expect(resolveSoleCumulativeMeter({
      items: [{ type: 'cumulative', values: { W: 640 } }],
    })).toEqual({ state: 'unresolvable', reason: 'idless_sole' });
    // An empty id normalizes to id-less.
    expect(resolveSoleCumulativeMeter({
      items: [{ type: 'cumulative', id: '', values: { W: 640 } }],
    })).toEqual({ state: 'unresolvable', reason: 'idless_sole' });
  });

  it('an id-less aggregate beside an id-bearing meter still makes two candidates', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', values: { W: 640 } },
        { type: 'cumulative', id: 'han', values: { W: 2_400 } },
      ],
    })).toEqual({ state: 'unresolvable', reason: 'ambiguous' });
  });

  it('counts an id-bearing cumulative row with a non-finite reading as a meter that exists', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', id: 'broken', values: { W: Number.NaN } },
        { type: 'cumulative', id: 'han', values: { W: 2_400 } },
      ],
    })).toEqual({ state: 'unresolvable', reason: 'ambiguous' });
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
    const retryable = { state: 'unresolvable', reason: 'none_found' };
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

describe('resolveSoleCumulativeMeter readiness', () => {
  it('keeps the finite reading when one meter appears twice, warming first', () => {
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', id: 'pulse', values: { W: null } },
        { type: 'cumulative', id: 'pulse', values: { W: 1200 } },
      ],
    })).toEqual({ state: 'resolved', meterDeviceId: 'pulse' });
  });

  it('counts an id-bearing cumulative meter that has not published finite watts yet', () => {
    const warming = { type: 'cumulative', id: 'em', values: { W: null } };
    const live = { type: 'cumulative', id: 'pulse', values: { W: 1200 } };
    // Two meters exist even though only one reads: never "sole".
    expect(resolveSoleCumulativeMeter({ items: [live, warming] }))
      .toEqual({ state: 'unresolvable', reason: 'ambiguous' });
    // The one meter, not yet publishing: not yet, not an answer.
    expect(resolveSoleCumulativeMeter({ items: [warming] }))
      .toEqual({ state: 'unresolvable', reason: 'none_found' });
    // An id-less row with nothing measured is nothing at all.
    expect(resolveSoleCumulativeMeter({ items: [live, { type: 'cumulative', values: { W: null } }] }))
      .toEqual({ state: 'resolved', meterDeviceId: 'pulse' });
  });
});

describe('resolveSoleCumulativeMeter id grammar', () => {
  it('counts a row with a malformed id and no reading as a meter that exists', () => {
    for (const id of ['bad|id', 42, { nested: true }]) {
      expect(resolveSoleCumulativeMeter({
        items: [
          { type: 'cumulative', id: 'pulse', values: { W: 1200 } },
          { type: 'cumulative', id, values: { W: null } },
        ],
      })).toEqual({ state: 'unresolvable', reason: 'ambiguous' });
    }
    // No id at all and nothing measured is not a row for anything.
    expect(resolveSoleCumulativeMeter({
      items: [
        { type: 'cumulative', id: 'pulse', values: { W: 1200 } },
        { type: 'cumulative', id: '', values: { W: null } },
      ],
    })).toEqual({ state: 'resolved', meterDeviceId: 'pulse' });
  });

  it('treats a non-canonical id as no id at all (idless_sole)', () => {
    expect(resolveSoleCumulativeMeter({ items: [{ type: 'cumulative', id: 'bad|id', values: { W: 900 } }] }))
      .toEqual({ state: 'unresolvable', reason: 'idless_sole' });
    expect(resolveSoleCumulativeMeter({ items: [{ type: 'cumulative', id: 'automatic', values: { W: 900 } }] }))
      .toEqual({ state: 'unresolvable', reason: 'idless_sole' });
  });
});

describe('resolveRegistryMeterCandidates', () => {
  const sensorMeter = (id: string) => ({ id, name: id, class: 'sensor', capabilities: ['measure_power'] });

  it('counts cumulative-marked devices and sensor-class power reporters, once each, from a map or a list', () => {
    const devices = {
      pulse: { id: 'pulse', name: 'Pulse', class: 'other', energy: { cumulative: true } },
      em: sensorMeter('em'),
      plug: { id: 'plug', name: 'Plug', class: 'socket', capabilities: ['measure_power', 'onoff'] },
      thermo: { id: 'thermo', name: 'Thermo', class: 'sensor', capabilities: ['measure_temperature'] },
      idless: { class: 'sensor', capabilities: ['measure_power'] },
    };
    expect(resolveRegistryMeterCandidates(devices)).toEqual(['pulse', 'em']);
    expect(resolveRegistryMeterCandidates(Object.values(devices))).toEqual(['pulse', 'em']);
    expect(resolveRegistryMeterCandidates({ obj: { id: 'obj', energyObj: { cumulative: true } } })).toEqual(['obj']);
    expect(resolveRegistryMeterCandidates(null)).toEqual([]);
  });

  it('adopts only when the registry corroborates the live sole meter and knows no other', () => {
    const live = { items: [{ type: 'cumulative', id: 'pulse', values: { W: 1200 } }] };
    expect(resolveSoleMeterAdoptionCandidate(live, { pulse: sensorMeter('pulse') }))
      .toEqual({ state: 'resolved', meterDeviceId: 'pulse' });
    // A registry that does not list the live meter as a meter has not
    // corroborated it: a partial read looks exactly like this. Not an answer.
    expect(resolveSoleMeterAdoptionCandidate(live, { pulse: { id: 'pulse', class: 'other' } }))
      .toEqual({ state: 'unresolvable', reason: 'registry_mismatch' });
    expect(resolveSoleMeterAdoptionCandidate(live, { plug: { id: 'plug', name: 'Plug', class: 'socket' } }))
      .toEqual({ state: 'unresolvable', reason: 'registry_mismatch' });
    // A second meter the registry knows but that has not published yet.
    expect(resolveSoleMeterAdoptionCandidate(live, { pulse: sensorMeter('pulse'), em: sensorMeter('em') }))
      .toEqual({ state: 'unresolvable', reason: 'ambiguous' });
    expect(resolveSoleMeterAdoptionCandidate(live, { em: sensorMeter('em') }))
      .toEqual({ state: 'unresolvable', reason: 'ambiguous' });
    // A live verdict that is not resolved never consults the registry.
    expect(resolveSoleMeterAdoptionCandidate({ items: [] }, { pulse: sensorMeter('pulse') }))
      .toEqual({ state: 'unresolvable', reason: 'none_found' });
  });
});
