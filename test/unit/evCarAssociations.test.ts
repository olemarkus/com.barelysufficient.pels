import { describe, expect, it } from 'vitest';
import { normalizeEvCarAssociations } from '../../packages/shared-domain/src/settings/evCarAssociations';

describe('normalizeEvCarAssociations', () => {
  it('keeps a well-formed eligibility set', () => {
    expect(normalizeEvCarAssociations({ 'charger-1': { carIds: ['car-a', 'car-b'] } }))
      .toEqual({ 'charger-1': { carIds: ['car-a', 'car-b'] } });
  });

  it('rejects non-object roots', () => {
    expect(normalizeEvCarAssociations(null)).toEqual({});
    expect(normalizeEvCarAssociations('nope')).toEqual({});
    expect(normalizeEvCarAssociations([{ carIds: ['car-a'] }])).toEqual({});
  });

  it('drops entries whose carIds are missing or not an array', () => {
    expect(normalizeEvCarAssociations({ 'charger-1': {}, 'charger-2': { carIds: 'car-a' } })).toEqual({});
  });

  it('drops non-string and empty car ids', () => {
    expect(normalizeEvCarAssociations({ 'charger-1': { carIds: ['car-a', 42, '', null] } }))
      .toEqual({ 'charger-1': { carIds: ['car-a'] } });
  });

  it('dedupes repeated car ids', () => {
    expect(normalizeEvCarAssociations({ 'charger-1': { carIds: ['car-a', 'car-a'] } }))
      .toEqual({ 'charger-1': { carIds: ['car-a'] } });
  });

  it('drops a charger left with no eligible car', () => {
    // An empty set is indistinguishable from "off", so storing it would leave a
    // charger reading as configured everywhere downstream.
    expect(normalizeEvCarAssociations({ 'charger-1': { carIds: [] }, 'charger-2': { carIds: [123] } })).toEqual({});
  });
});
