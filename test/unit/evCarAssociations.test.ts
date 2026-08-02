import { describe, expect, it } from 'vitest';
import { normalizeEvCarAssociations as normalizeContracts } from '../../packages/contracts/src/evCarAssociations';
import { normalizeEvCarAssociations as normalizeRuntime } from '../../lib/utils/evCarAssociations';

// The two copies exist because runtime may not take a value dependency on
// contracts and the settings UI may not import lib. Every case below runs
// against both so they cannot drift.
const both = (value: unknown) => {
  const runtime = normalizeRuntime(value);
  expect(normalizeContracts(value)).toEqual(runtime);
  return runtime;
};

describe('normalizeEvCarAssociations', () => {
  it('keeps a well-formed eligibility set', () => {
    expect(both({ 'charger-1': { carIds: ['car-a', 'car-b'] } }))
      .toEqual({ 'charger-1': { carIds: ['car-a', 'car-b'] } });
  });

  it('rejects non-object roots', () => {
    expect(both(null)).toEqual({});
    expect(both('nope')).toEqual({});
    expect(both([{ carIds: ['car-a'] }])).toEqual({});
  });

  it('drops entries whose carIds are missing or not an array', () => {
    expect(both({ 'charger-1': {}, 'charger-2': { carIds: 'car-a' } })).toEqual({});
  });

  it('drops non-string and empty car ids', () => {
    expect(both({ 'charger-1': { carIds: ['car-a', 42, '', null] } }))
      .toEqual({ 'charger-1': { carIds: ['car-a'] } });
  });

  it('dedupes repeated car ids', () => {
    expect(both({ 'charger-1': { carIds: ['car-a', 'car-a'] } }))
      .toEqual({ 'charger-1': { carIds: ['car-a'] } });
  });

  it('drops a charger left with no eligible car', () => {
    // An empty set is indistinguishable from "off", so storing it would leave a
    // charger reading as configured everywhere downstream.
    expect(both({ 'charger-1': { carIds: [] }, 'charger-2': { carIds: [123] } })).toEqual({});
  });
});
