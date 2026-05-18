import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PriceFlowTagPublisher, PRICE_LIST_UPDATED_TRIGGER_ID } from '../lib/price/priceFlowTags';
import { mockHomeyInstance } from './mocks/homey';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../lib/price/priceTypes';

const buildStore = (overrides: Partial<CombinedPricesV2> = {}): CombinedPricesV2 => ({
  version: 2,
  days: {},
  avgPrice: 100,
  lowThreshold: 75,
  highThreshold: 125,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
  ...overrides,
});

const day = (dateKey: string, count: number, total = 60): CombinedPriceEntry[] => (
  Array.from({ length: count }, (_, hour) => ({
    startsAt: `${dateKey}T${String(hour).padStart(2, '0')}:00:00+02:00`,
    total,
    isCheap: false,
    isExpensive: false,
  }))
);

const resetMock = (): void => {
  mockHomeyInstance.settings.clear();
  mockHomeyInstance.flow._tokens = {};
  mockHomeyInstance.flow._triggerCardTriggers = {};
  mockHomeyInstance.flow._triggerCardRunListeners = {};
};

const triggersFor = (id: string): { tokens: Record<string, unknown> }[] => (
  (mockHomeyInstance.flow._triggerCardTriggers[id] ?? []) as { tokens: Record<string, unknown> }[]
);

const newPublisher = () => new PriceFlowTagPublisher({
  homey: mockHomeyInstance as any,
  requestPriceRefetch: () => {},
  log: () => {},
  logDebug: () => {},
  error: () => {},
});

describe('PriceFlowTagPublisher', () => {
  beforeEach(() => {
    resetMock();
    vi.useFakeTimers().setSystemTime(new Date('2026-05-17T10:00:00+02:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the trigger with valid JSON when no prices exist', async () => {
    const publisher = newPublisher();
    await publisher.publish('startup');
    const triggers = triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID);
    expect(triggers).toHaveLength(1);
    const parsed = JSON.parse(triggers[0].tokens.prices_json as string);
    expect(parsed.today).toEqual([]);
    expect(parsed.tomorrow).toEqual([]);
  });

  it('fires the trigger with the lean export when prices exist', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: {
        '2026-05-17': { hours: day('2026-05-17', 24) },
        '2026-05-18': { hours: day('2026-05-18', 24, 70) },
      },
    }));
    const publisher = newPublisher();
    await publisher.publish('test');
    const triggers = triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID);
    expect(triggers).toHaveLength(1);
    const parsed = JSON.parse(triggers[0].tokens.prices_json as string);
    expect(parsed.today).toHaveLength(24);
    expect(parsed.tomorrow).toHaveLength(24);
    expect(parsed.unit).toBe('øre/kWh');
  });

  it('suppresses duplicate publishes when content fingerprint is unchanged', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24) } },
    }));
    const publisher = newPublisher();
    await publisher.publish('first');
    await publisher.publish('second-identical');
    expect(triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID)).toHaveLength(1);
  });

  it('fires the trigger again when content changes', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 50) } },
    }));
    const publisher = newPublisher();
    await publisher.publish('first');
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 80) } },
    }));
    await publisher.publish('second');
    const triggers = triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID);
    expect(triggers).toHaveLength(2);
    const parsed = JSON.parse(triggers[1].tokens.prices_json as string);
    expect(parsed.today).toHaveLength(24);
  });

  it('reflects tomorrow arrival as a non-empty tomorrow array', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24) } },
    }));
    const publisher = newPublisher();
    await publisher.publish('first');
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: {
        '2026-05-17': { hours: day('2026-05-17', 24) },
        '2026-05-18': { hours: day('2026-05-18', 24, 90) },
      },
    }));
    await publisher.publish('tomorrow-arrived');
    const triggers = triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID);
    expect(triggers).toHaveLength(2);
    const parsed = JSON.parse(triggers[1].tokens.prices_json as string);
    expect(parsed.tomorrow).toHaveLength(24);
  });

  it('emits standard double-quoted JSON parseable by JSON.parse without preprocessing', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24) } },
    }));
    const publisher = newPublisher();
    await publisher.publish('test');
    const raw = triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID)[0].tokens.prices_json as string;
    expect(raw.startsWith('{')).toBe(true);
    expect(raw).not.toMatch(/'/);
    expect(raw).toMatch(/"today":\s*\[/);
    expect(raw).toMatch(/"unit":\s*"øre\/kWh"/);
    const parsed = JSON.parse(raw);
    expect(parsed.today).toHaveLength(24);
  });

  it('retries failed publishes on the next update instead of latching the fingerprint', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 50) } },
    }));
    let throwNext = true;
    const triggerCalls: unknown[] = [];
    const publisher = new PriceFlowTagPublisher({
      homey: {
        ...mockHomeyInstance,
        flow: {
          ...mockHomeyInstance.flow,
          getTriggerCard: () => ({
            trigger: async (tokens: Record<string, unknown>) => {
              triggerCalls.push(tokens);
              if (throwNext) { throwNext = false; throw new Error('transient'); }
            },
          }),
        },
      } as any,
      requestPriceRefetch: () => {},
      log: () => {},
      logDebug: () => {},
      error: () => {},
    });
    await publisher.publish('first');
    // Same content again — must retry because the prior trigger threw, so
    // fingerprint should not have advanced.
    await publisher.publish('second-identical');
    expect(triggerCalls).toHaveLength(2);
  });
});
