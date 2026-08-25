import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistedEvCarLinkAccess } from '../../setup/appInit/evCarLinkAccess';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { EV_CAR_LINK_STATE } from '../../lib/utils/settingsKeys';
import { EV_CAR_LINK_VERSION } from '../../lib/device/evCarLinkSnapshot';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { HomeyRuntime } from '../../lib/ports/homeyRuntime';

const T0 = 1_000_000;

const voteSnapshot = (votes: number): EvCarLinkSnapshot => ({
  version: EV_CAR_LINK_VERSION,
  pairs: { 'car|charger': { votes, lastVotedAtMs: T0 } },
  cars: {},
  sessions: {},
});

describe('createPersistedEvCarLinkAccess persist guard', () => {
  let timers: TimerRegistry;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    timers = new TimerRegistry();
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  const buildHomey = (params: { failStateWrites: () => boolean }): {
    homey: HomeyRuntime;
    values: Map<string, unknown>;
    getCalls: () => number;
  } => {
    const values = new Map<string, unknown>();
    const counter = { reads: 0 };
    return {
      values,
      getCalls: () => counter.reads,
      homey: {
        settings: {
          get: (key: string): unknown => {
            counter.reads += 1;
            return values.get(key);
          },
          set: (key: string, value: unknown): void => {
            if (key === EV_CAR_LINK_STATE && params.failStateWrites()) {
              throw new Error('transient settings write failure');
            }
            values.set(key, value);
          },
          unset: (key: string): void => { values.delete(key); },
        },
      },
    };
  };

  it('does not start the guard — or touch settings — until the probe first uses the store', () => {
    const { homey, values, getCalls } = buildHomey({ failStateWrites: () => false });
    const access = createPersistedEvCarLinkAccess(homey, timers);
    expect(timers.has('evCarLinkPersistGuard')).toBe(false);
    // Time passing before first use fires nothing and reads nothing: a home
    // with no car must never touch the settings store at all.
    vi.advanceTimersByTime(10 * 65_000);
    expect(getCalls()).toBe(0);
    expect(values.size).toBe(0);
    access.get();
    expect(timers.has('evCarLinkPersistGuard')).toBe(true);
    expect(getCalls()).toBeGreaterThan(0);
  });

  it('retries a failed write on the guard tick, without another mutation', () => {
    let failWrites = true;
    const { homey, values } = buildHomey({ failStateWrites: () => failWrites });
    const access = createPersistedEvCarLinkAccess(homey, timers);
    access.set(voteSnapshot(1));
    // The immediate persist attempt failed; nothing durable yet.
    expect(values.has(EV_CAR_LINK_STATE)).toBe(false);
    failWrites = false;
    vi.advanceTimersByTime(65_000);
    const written = values.get(EV_CAR_LINK_STATE) as EvCarLinkSnapshot;
    expect(written.pairs['car|charger'].votes).toBe(1);
  });

  it('persists a mutation that landed inside the debounce, without another mutation', () => {
    const { homey, values } = buildHomey({ failStateWrites: () => false });
    const access = createPersistedEvCarLinkAccess(homey, timers);
    access.set(voteSnapshot(1));
    expect((values.get(EV_CAR_LINK_STATE) as EvCarLinkSnapshot).pairs['car|charger'].votes).toBe(1);
    // Second mutation 10 s later sits inside the 60 s debounce.
    vi.advanceTimersByTime(10_000);
    access.set(voteSnapshot(2));
    expect((values.get(EV_CAR_LINK_STATE) as EvCarLinkSnapshot).pairs['car|charger'].votes).toBe(1);
    // The guard tick at +65 s persists it with no further mutation arriving.
    vi.advanceTimersByTime(55_000);
    expect((values.get(EV_CAR_LINK_STATE) as EvCarLinkSnapshot).pairs['car|charger'].votes).toBe(2);
  });
});
