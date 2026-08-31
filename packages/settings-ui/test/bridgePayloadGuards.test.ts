// The two settings-UI adapters that receive a discriminated read back over the
// Homey API bridge. The bridge is an untrusted transport (AGENTS.md, "Clean and
// trusted interfaces"), so the `budget`/`readout` discriminant alone — which is
// only a compile-time claim about a `callApi` type argument — is not enough:
// each guard also has to see the fields its own module dereferences without a
// further check, or a partial answer reaches the render tree as `undefined`.
import { describe, expect, it } from 'vitest';
import { asBudgetPayload } from '../src/ui/dailyBudget.ts';
import { asReadoutPayload } from '../src/ui/weatherInsight.ts';

describe('asBudgetPayload — the /daily_budget bridge guard', () => {
  const payload = { days: { '2026-03-03': {} }, todayKey: '2026-03-03' };

  it('passes a complete budget read through unchanged', () => {
    expect(asBudgetPayload({ kind: 'budget', payload })).toBe(payload);
  });

  it.each([
    ['the named absence member', { kind: 'unavailable' }],
    ['a budget arm with no payload at all', { kind: 'budget' }],
    ['a payload missing days', { kind: 'budget', payload: { todayKey: '2026-03-03' } }],
    ['a payload whose todayKey is not a string', { kind: 'budget', payload: { days: {}, todayKey: 3 } }],
    ['an unknown discriminant', { kind: 'something-else', payload }],
    ['a bare payload sent without the read wrapper', payload],
    ['null', null],
    ['a non-object', 'budget'],
  ])('reads %s as no budget', (_label, wire) => {
    expect(asBudgetPayload(wire)).toBeNull();
  });
});

describe('asReadoutPayload — the /ui_weather_advisor_readout bridge guard', () => {
  const payload = { state: 'ready', settings: { outdoorDeviceId: 'dev-1' }, outdoorReading: {} };

  it('passes a complete readout through unchanged', () => {
    expect(asReadoutPayload({ kind: 'readout', payload })).toBe(payload);
  });

  it.each([
    ['the named inactive member', { kind: 'inactive' }],
    ['a readout arm with no payload at all', { kind: 'readout' }],
    // `settings` is dereferenced unguarded for the outdoor-device validity line.
    ['a payload missing settings', { kind: 'readout', payload: { state: 'ready', outdoorReading: {} } }],
    ['a payload missing outdoorReading', { kind: 'readout', payload: { state: 'ready', settings: {} } }],
    ['a payload whose state is not a string', { kind: 'readout', payload: { ...payload, state: 7 } }],
    ['null', null],
  ])('reads %s as no readout', (_label, wire) => {
    expect(asReadoutPayload(wire)).toBeNull();
  });
});
