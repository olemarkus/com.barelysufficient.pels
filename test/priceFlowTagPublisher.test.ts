import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PriceFlowTagPublisher, PRICE_FLOW_TAG_ID, PRICE_LIST_UPDATED_TRIGGER_ID } from '../lib/price/priceFlowTags';
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

const tokenValue = (): string => (mockHomeyInstance.flow._tokens[PRICE_FLOW_TAG_ID] as { value: string }).value;

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

  it('creates the global price token on init with a valid empty-JSON default', async () => {
    const publisher = newPublisher();
    await publisher.init();
    const token = mockHomeyInstance.flow._tokens[PRICE_FLOW_TAG_ID] as { type: string; value: string };
    expect(token).toBeDefined();
    expect(token.type).toBe('string');
    const parsed = JSON.parse(token.value);
    expect(parsed.today).toEqual([]);
    expect(parsed.tomorrow).toEqual([]);
    expect(parsed.unit).toBe('price units');
  });

  it('publishes the export to both the token and the trigger when prices exist', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: {
        '2026-05-17': { hours: day('2026-05-17', 24) },
        '2026-05-18': { hours: day('2026-05-18', 24, 70) },
      },
    }));
    const publisher = newPublisher();
    await publisher.init();
    await publisher.publish('test');
    const tokenParsed = JSON.parse(tokenValue());
    expect(tokenParsed.today).toHaveLength(24);
    expect(tokenParsed.tomorrow).toHaveLength(24);
    expect(tokenParsed.unit).toBe('øre/kWh');
    const triggers = triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID);
    expect(triggers).toHaveLength(1);
    expect(JSON.parse(triggers[0].tokens.prices_json as string)).toEqual(tokenParsed);
  });

  it('suppresses duplicate publishes when content fingerprint is unchanged', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24) } },
    }));
    const publisher = newPublisher();
    await publisher.init();
    await publisher.publish('first');
    const setValueCountAfterFirst = (mockHomeyInstance.flow._tokens[PRICE_FLOW_TAG_ID] as { setValueCount: number }).setValueCount;
    await publisher.publish('second-identical');
    const setValueCountAfterSecond = (mockHomeyInstance.flow._tokens[PRICE_FLOW_TAG_ID] as { setValueCount: number }).setValueCount;
    expect(setValueCountAfterSecond).toBe(setValueCountAfterFirst);
    expect(triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID)).toHaveLength(1);
  });

  it('fires both surfaces again when content changes', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 50) } },
    }));
    const publisher = newPublisher();
    await publisher.init();
    await publisher.publish('first');
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 80) } },
    }));
    await publisher.publish('second');
    const triggers = triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID);
    expect(triggers).toHaveLength(2);
    const tokenParsed = JSON.parse(tokenValue());
    expect(tokenParsed.today[0]).toBe(80);
  });

  it('reflects tomorrow arrival as a non-empty tomorrow array', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24) } },
    }));
    const publisher = newPublisher();
    await publisher.init();
    await publisher.publish('first');
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: {
        '2026-05-17': { hours: day('2026-05-17', 24) },
        '2026-05-18': { hours: day('2026-05-18', 24, 90) },
      },
    }));
    await publisher.publish('tomorrow-arrived');
    const tokenParsed = JSON.parse(tokenValue());
    expect(tokenParsed.tomorrow).toHaveLength(24);
  });

  it('emits standard double-quoted JSON parseable by JSON.parse without preprocessing', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24) } },
    }));
    const publisher = newPublisher();
    await publisher.init();
    await publisher.publish('test');
    const raw = tokenValue();
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
    const setValueCalls: string[] = [];
    const publisher = new PriceFlowTagPublisher({
      homey: {
        ...mockHomeyInstance,
        flow: {
          ...mockHomeyInstance.flow,
          createToken: async () => ({
            setValue: async (v: string) => {
              setValueCalls.push(v);
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
    await publisher.init();
    await publisher.publish('first');
    await publisher.publish('second-identical');
    expect(setValueCalls).toHaveLength(2);
  });

  it('retries createToken on the next publish when init throws', async () => {
    let throwNext = true;
    let createCalls = 0;
    const publisher = new PriceFlowTagPublisher({
      homey: {
        ...mockHomeyInstance,
        flow: {
          ...mockHomeyInstance.flow,
          createToken: async (id: string, opts: { type: string; title: string; value: unknown }) => {
            createCalls += 1;
            if (throwNext) { throwNext = false; throw new Error('flow-down'); }
            return mockHomeyInstance.flow.createToken(id, opts);
          },
        },
      } as any,
      requestPriceRefetch: () => {},
      log: () => {},
      logDebug: () => {},
      error: () => {},
    });
    await publisher.init();
    expect(createCalls).toBe(1);
    await publisher.publish('after-recover');
    expect(createCalls).toBe(2);
    expect(mockHomeyInstance.flow._tokens[PRICE_FLOW_TAG_ID]).toBeDefined();
  });

  it('still fires the price_list_updated trigger when setToken throws', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 50) } },
    }));
    const errors: unknown[][] = [];
    const publisher = new PriceFlowTagPublisher({
      homey: {
        ...mockHomeyInstance,
        flow: {
          ...mockHomeyInstance.flow,
          createToken: async () => ({
            setValue: async () => { throw new Error('tag-store-down'); },
          }),
        },
      } as any,
      requestPriceRefetch: () => {},
      log: () => {},
      logDebug: () => {},
      error: (...args: unknown[]) => { errors.push(args); },
    });
    await publisher.init();
    await publisher.publish('tag-broken');
    // Event-driven flows must still fire even when the tag-write path is broken.
    expect(triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID)).toHaveLength(1);
    // Tag-write failure must still be logged (not silently swallowed).
    const tagErrorLogged = errors.some((args) =>
      typeof args[0] === 'string' && args[0].includes('tag write failed'));
    expect(tagErrorLogged).toBe(true);
  });

  it('still fires the trigger when createToken never succeeded', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 50) } },
    }));
    const publisher = new PriceFlowTagPublisher({
      homey: {
        ...mockHomeyInstance,
        flow: {
          ...mockHomeyInstance.flow,
          createToken: async () => { throw new Error('flow-down'); },
        },
      } as any,
      requestPriceRefetch: () => {},
      log: () => {},
      logDebug: () => {},
      error: () => {},
    });
    await publisher.init();
    await publisher.publish('no-token');
    // Trigger fires even though the token was never registered — flows that
    // only subscribe to `price_list_updated` should not be blocked by the
    // missing global tag.
    expect(triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID)).toHaveLength(1);
  });

  it('retries the next publish when the trigger fires but the tag write failed', async () => {
    mockHomeyInstance.settings.set('combined_prices', buildStore({
      days: { '2026-05-17': { hours: day('2026-05-17', 24, 50) } },
    }));
    let throwNext = true;
    const setValueCalls: string[] = [];
    const publisher = new PriceFlowTagPublisher({
      homey: {
        ...mockHomeyInstance,
        flow: {
          ...mockHomeyInstance.flow,
          createToken: async () => ({
            setValue: async (v: string) => {
              setValueCalls.push(v);
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
    await publisher.init();
    await publisher.publish('first');
    await publisher.publish('second-identical');
    // Tag write retried (lastFingerprint not latched), and the trigger
    // fired both times since it was decoupled from the tag-write outcome.
    expect(setValueCalls).toHaveLength(2);
    expect(triggersFor(PRICE_LIST_UPDATED_TRIGGER_ID)).toHaveLength(2);
  });
});
