import { resolveUsableCapacityKw, resolvePlanningCeilingKw } from '../../lib/power/capacityModel';
import { resolveHeldPowerLimits } from '../../lib/power/heldCapacityLimit';
import { describe, expect, it } from 'vitest';
import { NorwayCapacityChoice } from '../../lib/power/norwayCapacityChoice';
import { NORWAY_CAPACITY_CHOICE_REQUEST } from '../../packages/shared-domain/src/settings/norwayCapacityChoice';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';

const scalars: CapacityScalarSettings = {
  limitKw: 5, marginKw: 0.2, periodMinutes: 60, capacityEnabled: true,
  gridImportLimitKw: null, dryRun: false, followMonthPeak: false,
};
const now = Date.parse('2026-11-18T12:00:00Z');
const offer = { monthKey: '2026-11', tariffIdentity: 'operator:group', limitKw: 9.9, revision: 'v1' };
const readTariff = () => ({ state: 'supported' as const, tariff: {
  identity: offer.tariffIdentity, boundariesKw: [0, 5, 10], thresholdIncluded: true,
} });
const fixture = () => {
  const data = new Map<string, unknown>();
  const settings = { get: (key: string) => data.get(key), set: (key: string, value: unknown) => { data.set(key, value); },
    unset: (key: string) => { data.delete(key); }, getKeys: () => [...data.keys()] };
  return { data, settings, choice: new NorwayCapacityChoice(settings, readTariff) };
};
describe('explicit monthly capacity choice', () => {
  it('expires across Oslo month boundary without overwriting the normal setting', () => {
    const { settings, choice } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer });
    expect(choice.processRequest(offer, scalars, now)).toBe(true);
    expect(choice.applyTo(scalars, now).limitKw).toBe(9.9);
    expect(choice.forPlanning(scalars, now)).toMatchObject({
      limitKw: 5, monthlyCapacityChoice: { startsAtMs: Date.parse('2026-10-31T23:00:00Z'), endsAtMs: Date.parse('2026-11-30T23:00:00Z'), limitKw: 9.9 },
    });
    expect(choice.forPlanning(scalars, Date.parse('2026-11-30T23:00:00Z'))).toMatchObject({
      limitKw: 5, monthlyCapacityChoice: { startsAtMs: Date.parse('2026-10-31T23:00:00Z'), endsAtMs: Date.parse('2026-11-30T23:00:00Z'), limitKw: 9.9 },
    });
    expect(choice.applyTo(scalars, Date.parse('2026-11-30T23:00:00Z')).limitKw).toBe(5);
    expect(scalars.limitKw).toBe(5);
    expect(new NorwayCapacityChoice(settings, readTariff).applyTo(scalars, now).limitKw).toBe(9.9);
  });
  it('reserves a 0.3 margin below a 4.8 hard cap for a 4.5 planning target through live and forward reads', () => {
    const { settings, choice } = fixture();
    const normal = { ...scalars, marginKw: 0.3 };
    const hardCapOffer = { ...offer, limitKw: 4.8 };
    settings.set('capacity_margin_kw', 0.3);
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer: hardCapOffer });
    expect(choice.processRequest(hardCapOffer, normal, now)).toBe(true);
    const live = resolveHeldPowerLimits(choice.applyTo(normal, now), { state: 'no_completed_quarter' });
    expect(live.limitKw).toBe(4.8);
    expect(resolveUsableCapacityKw(live)).toBeCloseTo(4.5, 10);
    expect(resolvePlanningCeilingKw(choice.forPlanning(normal, now), now)).toBeCloseTo(4.5, 10);
    settings.set('capacity_margin_kw', 0.3);
    choice.onSettingChanged('capacity_margin_kw');
    expect(choice.applyTo(normal, now).limitKw).toBe(4.8);
    settings.set('capacity_margin_kw', 0.4);
    choice.onSettingChanged('capacity_margin_kw');
    expect(choice.applyTo({ ...normal, marginKw: 0.4 }, now).limitKw).toBe(5);
    settings.set('capacity_margin_kw', 0.3);
    choice.onSettingChanged('capacity_margin_kw');
    expect(choice.applyTo(normal, now).limitKw).toBe(5);
  });
  it('rejects stale suggestions and ignores request replays', () => {
    const { settings, choice } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer });
    expect(choice.processRequest({ ...offer, revision: 'v2' }, scalars, now)).toBe(false);
    expect(choice.readOutcome().state).toBe('rejected');
    expect(choice.processRequest(offer, scalars, now)).toBe(false);
    expect(choice.applyTo(scalars, now)).toBe(scalars);
  });
  it('cancellation cannot revive when the owner returns to an old limit', () => {
    const { settings, choice } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer });
    choice.processRequest(offer, scalars, now);
    choice.cancel();
    expect(choice.applyTo(scalars, now).limitKw).toBe(5);
  });
  it('restores an accepted choice while price services start and rejects a known different tariff', () => {
    const { settings, choice } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer });
    choice.processRequest(offer, scalars, now);
    const restored = new NorwayCapacityChoice(settings, () => ({ state: 'unavailable', reason: 'startup' }));
    expect(restored.applyTo(scalars, now).limitKw).toBe(9.9);
    const changed = new NorwayCapacityChoice(settings, () => ({ state: 'unsupported', reason: 'non_norway_scheme' }));
    expect(changed.applyTo(scalars, now).limitKw).toBe(5);
  });
  it('keeps a same-value Flow write but cancels an actual edit even if changed back', () => {
    const { settings, choice } = fixture();
    settings.set('capacity_limit_kw', 5);
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer });
    choice.processRequest(offer, scalars, now);
    settings.set('capacity_limit_kw', 5);
    choice.onSettingChanged('capacity_limit_kw');
    expect(choice.applyTo(scalars, now).limitKw).toBe(9.9);
    settings.set('capacity_limit_kw', 6);
    choice.onSettingChanged('capacity_limit_kw');
    settings.set('capacity_limit_kw', 5);
    choice.onSettingChanged('capacity_limit_kw');
    expect(choice.applyTo(scalars, now).limitKw).toBe(5);
  });
  it('restores the normal limit when the saved choice lacks its configuration snapshot', () => {
    const { data, settings, choice } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer });
    choice.processRequest(offer, scalars, now);
    expect(new NorwayCapacityChoice(settings, readTariff).applyTo(scalars, now).limitKw).toBe(9.9);
    const { configuration: _dropped, ...withoutSnapshot } = data.get('norway_capacity_choice_state') as Record<string, unknown>;
    settings.set('norway_capacity_choice_state', withoutSnapshot);
    expect(new NorwayCapacityChoice(settings, readTariff).applyTo(scalars, now).limitKw).toBe(5);
  });
  it('does not activate a choice if its accepted state cannot be persisted', () => {
    const { settings, choice } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'a', action: 'apply', offer });
    settings.set = () => { throw new Error('write failed'); };
    expect(() => choice.processRequest(offer, scalars, now)).toThrow('write failed');
    expect(choice.applyTo(scalars, now)).toBe(scalars);
  });
});
