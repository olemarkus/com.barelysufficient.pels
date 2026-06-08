// SDK-boundary e2e (createApp) — CHARACTERIZATION: how TWO priority-1 stepped
// devices, each carrying a smart task with BOTH standing permissions (boost =
// limit-lower-priority, AND exempt-from-budget), behave when they compete for a
// NARROW hard-cap headroom, with mixed prices and the daily budget ON.
//
// THE RULE THIS TEST FOLLOWS (notes/testing-taxonomy.md): nothing internal is
// mocked, the scenario is driven ONLY at the Homey SDK boundary (mock devices,
// `combined_prices`, the daily-budget settings, the clock, the energy poll, the
// persisted learned rate), the cycle is driven by the SDK timers, and the
// behaviour is OBSERVED ONLY through structured logs at the Homey logging seam.
//
// What it documents (verified deterministic):
//  1. Both boost tasks ENGAGE and BYPASS the shed invariant. A lower-priority
//     device is held shed (its restore load dwarfs any headroom); without boost
//     the shed invariant would reject each tank's escalation. With boost, BOTH
//     tanks get `restore_stepped_admitted` (`blockedByShedInvariant: false`).
//  2. Exempt lifts the daily-budget cap for both (`budgetExemptApplied: true`),
//     so the binding per-hour constraint is the PHYSICAL hard cap, not the soft
//     daily-budget slice.
//  3. Under the narrow hard cap they CONTEND: both at their low step already fill
//     the cap to within one small step, so the restore lane admits ONE escalation
//     at a time (the other waits on its meter-settling window) — they take turns,
//     never both stepping up in the same cycle.
//  4. Neither can fully reach target by the deadline under the narrow cap; the
//     reserved headroom is split between the two equal-priority tasks, so both
//     book the same floor energy and both resolve `cannot_meet`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  COMBINED_PRICES, CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED, DAILY_BUDGET_KWH,
  DEBUG_LOGGING_TOPICS, DEVICE_TARGET_POWER_CONFIGS, MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';

const HOUR_MS = 60 * 60 * 1000;
const DAY = Date.UTC(2026, 4, 10, 0, 0, 0);
const TODAY_KEY = new Date(DAY).toISOString().slice(0, 10);
const TANK_A = 'tank_a';
const TANK_B = 'tank_b';
const LOWER = 'lower';

const TARGET_C = 53;
const CURRENT_C = 48; // both cold enough to want to run hard
const KWH_PER_DEGREE = 1.5;
const STEP_LOW_W = 1500;
// Narrow hard cap: both tanks at their low step already draw 3.0 kW, leaving only
// ~0.5 kW of hard-cap headroom — one small escalation's worth, shared by two.
const CAPACITY_LIMIT = 3.5;
// A lower-priority restore demand far above any headroom, so it stays shed every
// cycle and the shed invariant is in force for the two tanks.
const LOWER_LOAD_W = 8000;
// Mixed prices: a cheap current hour (so both tasks are in a planned hour and want
// to run now) against dearer hours.
const PRICES = [8, 40, 8, 40, 30, 30, 30, 30, 30, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];

// A smart task with BOTH standing permissions: boost (limit-lower-priority) and
// exempt-from-budget — the only pairing the create gate persists.
const boostExemptTask = () => ({
  enabled: true,
  kind: 'temperature' as const,
  enforcement: 'soft' as const,
  targetTemperatureC: TARGET_C,
  deadlineAtMs: DAY + 6 * HOUR_MS,
  rescue: { limitLowerPriorityDevices: 'always' as const, exemptFromBudget: 'always' as const },
});

const buildCombinedPrices = () => ({
  version: 2,
  days: {
    [TODAY_KEY]: {
      hours: PRICES.map((total, i) => ({
        startsAt: new Date(DAY + i * HOUR_MS).toISOString(),
        total,
        isCheap: false,
        isExpensive: false,
      })),
    },
  },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

const trackerProfile = (nowMs: number) => ({
  kind: 'temperature' as const,
  updatedAtMs: DAY,
  lastSample: { observedAtMs: DAY, value: CURRENT_C, unit: 'degree_c' as const },
  kwhPerUnit: {
    sampleCount: 50, mean: KWH_PER_DEGREE, m2: 0, min: KWH_PER_DEGREE, max: KWH_PER_DEGREE,
    confidence: 'high' as const, lastUpdatedMs: nowMs,
  },
  acceptedSamples: 50,
  rejectedSamples: 0,
});

type SteppedEvent = {
  event?: string;
  deviceId?: string;
  toStepId?: string;
  rejectionReason?: string;
  blockedByShedInvariant?: boolean;
};
type DeferredDiag = {
  deviceId?: string;
  status?: string;
  budgetExemptApplied?: boolean;
  limitLowerPriorityApplied?: boolean;
};
type RestoreRejected = { event?: string; deviceId?: string };

const buildTank = async (id: string): Promise<MockDevice> => {
  const d = new MockDevice(id, id,
    ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'target_power'], 'heater');
  await d.setCapabilityValue('measure_power', STEP_LOW_W);
  await d.setCapabilityValue('measure_temperature', CURRENT_C);
  await d.setCapabilityValue('target_temperature', TARGET_C);
  await d.setCapabilityValue('onoff', true);
  await d.setCapabilityValue('target_power', STEP_LOW_W);
  return d;
};

describe('two boost+exempt smart tasks, narrow headroom, daily budget ON (SDK-boundary e2e via createApp)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'Date'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('both tasks boost past the shed invariant and take turns under the narrow hard cap; neither meets target', async () => {
    vi.setSystemTime(new Date(DAY + 30 * 60 * 1000));
    mockHomeyInstance.settings.set(DEBUG_LOGGING_TOPICS, ['plan', 'diagnostics', 'deferred_objectives']);
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAPACITY_LIMIT);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    // Daily budget ON — but both tasks are exempt, so the budget slice never binds.
    mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, true);
    mockHomeyInstance.settings.set(DAILY_BUDGET_KWH, 30);
    mockHomeyInstance.settings.set('price_optimization_enabled', true);
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { [TANK_A]: true, [TANK_B]: true, [LOWER]: true });
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [TANK_A]: true, [TANK_B]: true, [LOWER]: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { [TANK_A]: 1, [TANK_B]: 1, [LOWER]: 5 } });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
      [TANK_A]: { enabled: true, min: 0, max: 3000, step: 500 },
      [TANK_B]: { enabled: true, min: 0, max: 3000, step: 500 },
    });
    mockHomeyInstance.settings.set(COMBINED_PRICES, buildCombinedPrices());
    mockHomeyInstance.settings.set('power_tracker_state', {
      lastTimestamp: DAY,
      objectiveProfiles: { [TANK_A]: trackerProfile(DAY), [TANK_B]: trackerProfile(DAY) },
    });
    mockHomeyInstance.settings.set(`deferred_objective.${TANK_A}`, boostExemptTask());
    mockHomeyInstance.settings.set(`deferred_objective.${TANK_B}`, boostExemptTask());

    const tankA = await buildTank(TANK_A);
    const tankB = await buildTank(TANK_B);
    const lower = new MockDevice(LOWER, 'Lower', ['onoff', 'measure_power'], 'heater');
    await lower.setCapabilityValue('onoff', false);
    await lower.setCapabilityValue('measure_power', 0);
    lower.setSettings({ load: LOWER_LOAD_W });
    setMockDrivers({ d: new MockDriver('d', [tankA, tankB, lower]) });

    // Both tanks at their low step → 3.0 kW total reported through the SDK energy poll.
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') return { items: [{ type: 'cumulative', values: { W: 2 * STEP_LOW_W } }] };
      return originalGet(path);
    });

    const app = createApp();
    const stepped: SteppedEvent[] = [];
    const diags: DeferredDiag[] = [];
    const lowerRejected: RestoreRejected[] = [];
    const origLog = app.log.bind(app);
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const e = JSON.parse(arg) as { event?: string; deviceId?: string } & SteppedEvent & DeferredDiag;
          if (typeof e.event === 'string' && e.event.startsWith('restore_stepped_')) stepped.push(e);
          else if (e.event === 'deferred_objective_horizon_planned') diags.push(e);
          else if (e.event === 'restore_rejected' && e.deviceId === LOWER) lowerRejected.push(e);
        } catch { /* non-JSON */ }
      }
      return origLog(...args);
    };
    await app.onInit();
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainUntil(() => false, { rounds: 20 }).catch(() => {});
    }

    const admittedFor = (id: string): SteppedEvent | undefined => (
      stepped.find((e) => e.event === 'restore_stepped_admitted' && e.deviceId === id)
    );
    const shedInvariantRejectFor = (id: string): SteppedEvent | undefined => (
      stepped.find((e) => e.event === 'restore_stepped_rejected'
        && e.deviceId === id && e.rejectionReason === 'shed_invariant')
    );
    const lastDiag = (id: string): DeferredDiag | undefined => (
      [...diags].reverse().find((d) => d.deviceId === id)
    );

    // (1) BOTH boost tasks bypass the shed invariant — each is admitted to escalate
    // past its low step DESPITE the lower-priority device being shed.
    expect(admittedFor(TANK_A)).toMatchObject({ toStepId: '2000w', blockedByShedInvariant: false });
    expect(admittedFor(TANK_B)).toMatchObject({ toStepId: '2000w', blockedByShedInvariant: false });
    // ...and the shed invariant never rejected either of them.
    expect(shedInvariantRejectFor(TANK_A)).toBeUndefined();
    expect(shedInvariantRejectFor(TANK_B)).toBeUndefined();

    // (2) Both tasks are exempt and carry the boost permission; the daily-budget
    // slice is lifted (so the hard cap — not the budget — is the binding limit).
    for (const id of [TANK_A, TANK_B]) {
      expect(lastDiag(id)).toMatchObject({ budgetExemptApplied: true, limitLowerPriorityApplied: true });
    }

    // (3) The lower-priority device stays shed — the boost tasks never let it back
    // on; it is rejected for restore every cycle it tries.
    expect(lowerRejected.length).toBeGreaterThan(0);

    // (4) They take turns under the narrow hard cap: the restore lane serializes
    // escalations (one per cycle), so while one tank is admitted the OTHER waits on
    // its meter-settling window (`restore_stepped_rejected` / `meter_settling`)
    // rather than escalating simultaneously. Both are admitted over the run.
    const admitOrder = stepped
      .filter((e) => e.event === 'restore_stepped_admitted')
      .map((e) => e.deviceId);
    expect(admitOrder).toContain(TANK_A);
    expect(admitOrder).toContain(TANK_B);
    const meterSettlingWait = stepped.some(
      (e) => e.event === 'restore_stepped_rejected' && e.rejectionReason === 'meter_settling',
    );
    expect(meterSettlingWait).toBe(true);

    // (5) Under the narrow cap neither task can reach target by the deadline — the
    // reserved headroom is split between the two equal-priority tasks, so both end
    // up `cannot_meet` rather than one starving the other.
    expect(lastDiag(TANK_A)?.status).toBe('cannot_meet');
    expect(lastDiag(TANK_B)?.status).toBe('cannot_meet');
  });
});
