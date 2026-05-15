import {
  IDLE_HOLD_MIN_DURATION_MS,
  IDLE_UNRESPONSIVE_MIN_DURATION_MS,
  NEAR_TARGET_TEMPERATURE_DELTA_C,
  NEAR_TARGET_TEMPERATURE_EXIT_DELTA_C,
  classifyIdleState,
  pruneIdleDetectorState,
  type IdleDetectorInput,
  type IdleDetectorState,
} from '../lib/observer/idleDetector';

const baseInput = (overrides: Partial<IdleDetectorInput> = {}): IdleDetectorInput => ({
  deviceId: 'dev-1',
  now: 1_000_000,
  measuredPowerKw: 0,
  currentTemperature: 62,
  targetTemperature: 65,
  observedOn: true,
  observationStale: false,
  pelsCommandedShed: false,
  hasTemperatureSetpoint: true,
  isEvCharger: false,
  ...overrides,
});

describe('classifyIdleState — eligibility gates', () => {
  it('returns active and clears state for EV chargers', () => {
    const state: IdleDetectorState = new Map();
    state.set('dev-1', { idleSinceMs: 0, lastClassification: 'near_target_idle' });
    const result = classifyIdleState(baseInput({ isEvCharger: true }), state);
    expect(result.classification).toBe('active');
    expect(state.has('dev-1')).toBe(false);
  });

  it('returns active for devices without a temperature setpoint', () => {
    const result = classifyIdleState(
      baseInput({ hasTemperatureSetpoint: false, targetTemperature: undefined }),
      new Map(),
    );
    expect(result.classification).toBe('active');
  });

  it('returns active when observation is stale', () => {
    const result = classifyIdleState(baseInput({ observationStale: true }), new Map());
    expect(result.classification).toBe('active');
  });

  it('returns active when PELS commanded shed', () => {
    const result = classifyIdleState(baseInput({ pelsCommandedShed: true }), new Map());
    expect(result.classification).toBe('active');
  });

  it('returns active when the device is observably off', () => {
    const result = classifyIdleState(baseInput({ observedOn: false }), new Map());
    expect(result.classification).toBe('active');
  });

  it('returns active when measured draw exceeds the idle threshold', () => {
    const result = classifyIdleState(baseInput({ measuredPowerKw: 0.1 }), new Map());
    expect(result.classification).toBe('active');
  });
});

describe('classifyIdleState — near_target_idle', () => {
  it('does not flip during a short anti-cycle gap below the hold window', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(baseInput({ now: t0 }), state);
    const midCycle = classifyIdleState(
      baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS - 1 }),
      state,
    );
    expect(midCycle.classification).toBe('active');
  });

  it('flips to near_target_idle after sustained idle near setpoint', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(baseInput({ now: t0 }), state);
    const sustained = classifyIdleState(
      baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS }),
      state,
    );
    expect(sustained.classification).toBe('near_target_idle');
    expect(sustained.idleDurationMs).toBe(IDLE_HOLD_MIN_DURATION_MS);
  });

  it('classifies the Connected 300 scenario (61.5°C / 65°C) as near_target_idle', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(baseInput({ now: t0, currentTemperature: 61.5 }), state);
    const sustained = classifyIdleState(
      baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS, currentTemperature: 61.5 }),
      state,
    );
    expect(sustained.classification).toBe('near_target_idle');
    expect(sustained.temperatureGapC).toBeCloseTo(3.5);
  });

  it('clears immediately when measured draw resumes', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(baseInput({ now: t0 }), state);
    classifyIdleState(baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS }), state);
    const resumed = classifyIdleState(
      baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS + 1_000, measuredPowerKw: 0.8 }),
      state,
    );
    expect(resumed.classification).toBe('active');
    expect(state.has('dev-1')).toBe(false);
  });

  it('reports the prior streak duration on the clear transition', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(baseInput({ now: t0 }), state);
    classifyIdleState(baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS }), state);
    const heldDuration = IDLE_HOLD_MIN_DURATION_MS + 90_000;
    const resumed = classifyIdleState(
      baseInput({ now: t0 + heldDuration, measuredPowerKw: 1.1 }),
      state,
    );
    expect(resumed.idleDurationMs).toBe(heldDuration);
    expect(resumed.previousClassification).toBe('near_target_idle');
  });

  it('holds across the entry/exit hysteresis band', () => {
    expect(NEAR_TARGET_TEMPERATURE_EXIT_DELTA_C).toBeGreaterThan(NEAR_TARGET_TEMPERATURE_DELTA_C);
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(baseInput({ now: t0, currentTemperature: 60.1 }), state); // gap 4.9 — enters
    const entered = classifyIdleState(
      baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS, currentTemperature: 60.1 }),
      state,
    );
    expect(entered.classification).toBe('near_target_idle');
    const drifting = classifyIdleState(
      baseInput({
        now: t0 + IDLE_HOLD_MIN_DURATION_MS + 1_000,
        currentTemperature: 59.7, // gap 5.3 — outside entry but inside exit hysteresis
      }),
      state,
    );
    expect(drifting.classification).toBe('near_target_idle');
  });
});

describe('classifyIdleState — unresponsive', () => {
  it('reports unresponsive when idle and well below setpoint for the unresponsive window', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    const coldInput = baseInput({ currentTemperature: 55 }); // 10°C below setpoint
    classifyIdleState({ ...coldInput, now: t0 }, state);
    const result = classifyIdleState(
      { ...coldInput, now: t0 + IDLE_UNRESPONSIVE_MIN_DURATION_MS },
      state,
    );
    expect(result.classification).toBe('unresponsive');
  });

  it('does not report unresponsive until the longer duration elapses', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    const coldInput = baseInput({ currentTemperature: 55 });
    classifyIdleState({ ...coldInput, now: t0 }, state);
    const stillEarly = classifyIdleState(
      { ...coldInput, now: t0 + IDLE_HOLD_MIN_DURATION_MS + 10_000 },
      state,
    );
    expect(stillEarly.classification).toBe('active');
  });

  it('clears unresponsive when the device starts drawing again', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    const coldInput = baseInput({ currentTemperature: 55 });
    classifyIdleState({ ...coldInput, now: t0 }, state);
    classifyIdleState(
      { ...coldInput, now: t0 + IDLE_UNRESPONSIVE_MIN_DURATION_MS },
      state,
    );
    const resumed = classifyIdleState(
      { ...coldInput, now: t0 + IDLE_UNRESPONSIVE_MIN_DURATION_MS + 1_000, measuredPowerKw: 1.5 },
      state,
    );
    expect(resumed.classification).toBe('active');
  });
});

describe('pruneIdleDetectorState', () => {
  it('drops entries for device ids not in the live set', () => {
    const state: IdleDetectorState = new Map();
    state.set('keep', { idleSinceMs: 1, lastClassification: 'near_target_idle' });
    state.set('drop', { idleSinceMs: 2, lastClassification: 'unresponsive' });
    pruneIdleDetectorState(state, ['keep']);
    expect(state.has('keep')).toBe(true);
    expect(state.has('drop')).toBe(false);
  });
});
