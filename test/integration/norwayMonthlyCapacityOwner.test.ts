import { afterEach, describe, expect, it, vi } from 'vitest';
import { NorwayMonthlyCapacityOwner } from '../../lib/power/norwayMonthlyCapacityOwner';
import { NorwayCapacityChoice } from '../../lib/power/norwayCapacityChoice';
import { norwayMonthStartMs } from '../../lib/power/norwayMonthlyCapacity';
import { NORWAY_CAPACITY_CHOICE_REQUEST } from '../../packages/shared-domain/src/settings/norwayCapacityChoice';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import type { NorwayCapacityTariffRead } from '../../packages/contracts/src/norwayCapacityTariff';

const now = Date.parse('2026-11-04T12:00:00+01:00');
const scalars: CapacityScalarSettings = {
  limitKw: 5, marginKw: 0.2, periodMinutes: 60, capacityEnabled: true,
  gridImportLimitKw: null, dryRun: false, followMonthPeak: false,
};
const fixture = (partial = false, peaks: readonly number[] = [5.5, 5.3, 5.1]) => {
  const data = new Map<string, unknown>([['capacity_limit_kw', scalars.limitKw], ['capacity_margin_kw', scalars.marginKw]]);
  const settings = {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => { data.set(key, value); },
    unset: (key: string) => { data.delete(key); }, getKeys: () => [...data.keys()],
  };
  let tariff: NorwayCapacityTariffRead = { state: 'supported', tariff: {
    identity: 'operator', boundariesKw: [0, 2, 5, 10], thresholdIncluded: true,
  } };
  const readTariff = () => tariff;
  const choice = new NorwayCapacityChoice(settings, readTariff);
  const rebuild = vi.fn();
  const owner = new NorwayMonthlyCapacityOwner({
    readTracker: () => ({ buckets: Object.fromEntries([
      ...(partial ? [] : Array.from({ length: Math.floor((now - norwayMonthStartMs(now)) / 3_600_000) + 1 }, (_, hour) => (
        [new Date(norwayMonthStartMs(now) + hour * 3_600_000).toISOString(), 0] as const
      ))),
      ...peaks.map((kw, index) => (
        [new Date(`2026-11-0${index + 1}T10:00:00+01:00`).toISOString(), kw] as const
      )),
    ]) }),
    readScalars: () => scalars, readTariff,
    readTimeZone: () => 'Europe/Oslo', requestRebuild: rebuild,
  }, choice);
  const read = owner.read(now);
  if (read.state !== 'ready' || read.advice.state !== 'suggestion') throw new Error('Expected advice');
  const offer = { monthKey: read.monthKey, tariffIdentity: read.tariffIdentity,
    limitKw: read.advice.limitKw, revision: read.advice.version };
  return { data, settings, choice, rebuild, owner, offer,
    setTariff: (value: NorwayCapacityTariffRead) => { tariff = value; } };
};

afterEach(() => { vi.useRealTimers(); });
describe('monthly capacity request boundary', () => {
  it('applies a partial-history reduction only for this month and supports cancel without changing the normal cap', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { data, settings, choice, owner, offer } = fixture(true, [5.17249, 4.93678, 4.65847]);
    expect(owner.read(now)).toMatchObject({ coverage: 'partial', advice: { actionable: true, limitKw: 4.8 } });
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'partial-lower', action: 'apply', offer });
    owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST);
    expect(choice.readOutcome()).toMatchObject({ state: 'accepted', requestId: 'partial-lower' });
    expect(choice.applyTo(scalars, now).limitKw).toBe(4.8);
    expect(data.get('capacity_limit_kw')).toBe(5);
    expect(choice.applyTo(scalars, Date.parse('2026-11-30T23:00:00Z')).limitKw).toBe(5);
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'cancel', action: 'cancel' });
    owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST);
    expect(choice.applyTo(scalars, now).limitKw).toBe(5);
    expect(data.get('capacity_limit_kw')).toBe(5);
  });
  it('rejects a partial-history increase at the command boundary', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { settings, choice, owner, offer, rebuild } = fixture(true);
    expect(owner.read(now)).toMatchObject({ coverage: 'partial', advice: { actionable: false, limitKw: 9.9 } });
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'partial-raise', action: 'apply', offer });
    owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST);
    expect(choice.readOutcome()).toMatchObject({ state: 'rejected', requestId: 'partial-raise' });
    expect(choice.applyTo(scalars, now).limitKw).toBe(5);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('accepts a fresh explicit request and rebuilds once', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { settings, choice, rebuild, owner, offer } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'apply', action: 'apply', offer });
    owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST);
    owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST);
    expect(choice.applyTo(scalars, now).limitKw).toBe(9.9);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
  it('catches failed persistence and exposes rejection without activating the change', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { settings, choice, rebuild, owner, offer } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'apply', action: 'apply', offer });
    settings.set = () => { throw new Error('storage unavailable'); };
    expect(() => owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST)).not.toThrow();
    expect(choice.applyTo(scalars, now).limitKw).toBe(5);
    expect(choice.readOutcome()).toMatchObject({ state: 'rejected', requestId: 'apply' });
    expect(rebuild).not.toHaveBeenCalled();
  });
  it('ignores stale requests and prevents a different operator from inheriting an accepted choice', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { settings, choice, owner, offer, setTariff } = fixture();
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'apply', action: 'apply', offer });
    owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST);
    setTariff({ state: 'supported', tariff: {
      identity: 'another', boundariesKw: [0, 2, 5, 10], thresholdIncluded: true,
    } });
    expect(choice.applyTo(scalars, now).limitKw).toBe(5);
    settings.set(NORWAY_CAPACITY_CHOICE_REQUEST, { id: 'stale', action: 'apply', offer });
    owner.onSettingChanged(NORWAY_CAPACITY_CHOICE_REQUEST);
    expect(choice.readOutcome()).toMatchObject({ state: 'rejected', requestId: 'stale' });
  });
});
