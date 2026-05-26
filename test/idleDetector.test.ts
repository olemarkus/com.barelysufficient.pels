import {
  CAPPED_IDLE_MIN_WINDOW_MS,
  IDLE_HOLD_MIN_DURATION_MS,
  IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS,
  IDLE_UNRESPONSIVE_MIN_DURATION_MS,
  NEAR_TARGET_TEMPERATURE_DELTA_C,
  NEAR_TARGET_TEMPERATURE_EXIT_DELTA_C,
  NEAR_TARGET_TIGHT_GAP_C,
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

  it('clears the classification immediately when measured draw resumes', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(baseInput({ now: t0 }), state);
    classifyIdleState(baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS }), state);
    const resumed = classifyIdleState(
      baseInput({ now: t0 + IDLE_HOLD_MIN_DURATION_MS + 1_000, measuredPowerKw: 0.8 }),
      state,
    );
    expect(resumed.classification).toBe('active');
    // State is retained — the sample-history backing the `capped_idle`
    // cycling detector must outlast individual on/off transitions, so the
    // entry persists with a refreshed `idleSinceMs` anchor and an updated
    // `lastClassification` of 'active'. Eligibility-violation paths
    // (device shed / off / stale) still delete the entry.
    expect(state.get('dev-1')?.lastClassification).toBe('active');
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

describe('classifyIdleState — tight-gap near_target_idle (1 °C / 1 min)', () => {
  // The kontor scenario: thermostat satisfies within ~0.1 °C of setpoint and
  // cycles 1–3 min on / off. The standard 5 °C / 5 min path never fires
  // because no individual idle window reaches 5 min; the tight-gap path
  // promotes after a single 1 min idle window so the smart-task recorder can
  // finalise met/stalled rather than missed/energy_underestimate.
  const tightInput = (overrides: Partial<IdleDetectorInput> = {}): IdleDetectorInput => baseInput({
    currentTemperature: 20.9,
    targetTemperature: 21,
    ...overrides,
  });

  it('does not flip below the tight idle duration', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(tightInput({ now: t0 }), state);
    const tooShort = classifyIdleState(
      tightInput({ now: t0 + IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS - 1 }),
      state,
    );
    expect(tooShort.classification).toBe('active');
  });

  it('flips to near_target_idle after 1 min idle within 1 °C of setpoint', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(tightInput({ now: t0 }), state);
    const promoted = classifyIdleState(
      tightInput({ now: t0 + IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS }),
      state,
    );
    expect(promoted.classification).toBe('near_target_idle');
    expect(promoted.idleDurationMs).toBe(IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS);
    expect(promoted.temperatureGapC).toBeCloseTo(0.1);
  });

  it('keeps the kontor case (0.1 °C off, 60 s idle) classified', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(tightInput({ now: t0 }), state);
    const promoted = classifyIdleState(
      tightInput({ now: t0 + 60_000 }),
      state,
    );
    expect(promoted.classification).toBe('near_target_idle');
  });

  it('does not promote at the tight duration when gap exceeds 1 °C', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    // Gap = 2 °C — outside tight band but inside standard 5 °C band.
    classifyIdleState(tightInput({ now: t0, currentTemperature: 19 }), state);
    const notYet = classifyIdleState(
      tightInput({
        now: t0 + IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS,
        currentTemperature: 19,
      }),
      state,
    );
    expect(notYet.classification).toBe('active');
    // …and still waits the full standard hold duration to fire.
    const fullHold = classifyIdleState(
      tightInput({
        now: t0 + IDLE_HOLD_MIN_DURATION_MS,
        currentTemperature: 19,
      }),
      state,
    );
    expect(fullHold.classification).toBe('near_target_idle');
  });

  it('stays in near_target_idle when gap drifts past 1 °C after entry (uses exit hysteresis)', () => {
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(tightInput({ now: t0 }), state);
    const entered = classifyIdleState(
      tightInput({ now: t0 + IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS }),
      state,
    );
    expect(entered.classification).toBe('near_target_idle');
    // Drift to a 1.4 °C gap — outside the tight 1 °C entry but well inside
    // the standard 5.5 °C exit hysteresis. Should hold via the previous-
    // near_target_idle stay-in branch in the tight-gap path.
    const drifted = classifyIdleState(
      tightInput({
        now: t0 + IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS + 30_000,
        currentTemperature: 19.6,
      }),
      state,
    );
    expect(drifted.classification).toBe('near_target_idle');
  });

  it('keeps the constants in the expected envelope', () => {
    expect(NEAR_TARGET_TIGHT_GAP_C).toBeGreaterThan(0);
    expect(NEAR_TARGET_TIGHT_GAP_C).toBeLessThan(NEAR_TARGET_TEMPERATURE_DELTA_C);
    expect(IDLE_HOLD_TIGHT_GAP_MIN_DURATION_MS).toBeLessThan(IDLE_HOLD_MIN_DURATION_MS);
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

describe('classifyIdleState — capped_idle', () => {
  // Drives the rolling window with alternating on/off ticks so the cycling
  // detector sees both halves of the device's internal duty cycle. Each
  // tick advances by `stepMs`; the temperature stays parked at `tempC`.
  const driveCycling = (
    state: IdleDetectorState,
    params: {
      startMs: number;
      tempC: number;
      targetC: number;
      durationMs: number;
      stepMs: number;
      onPowerKw: number;
    },
  ): number => {
    let cursor = params.startMs;
    let drawing = true;
    while (cursor <= params.startMs + params.durationMs) {
      classifyIdleState(
        baseInput({
          now: cursor,
          measuredPowerKw: drawing ? params.onPowerKw : 0,
          currentTemperature: params.tempC,
          targetTemperature: params.targetC,
        }),
        state,
      );
      cursor += params.stepMs;
      drawing = !drawing;
    }
    return cursor;
  };

  it('classifies a cycling heater stuck at its own cap as capped_idle', () => {
    // Connected 300 worked example: internal cap parks the tank ~5–7 °C
    // below the PELS smart-task target (60 °C cap against 65 °C target =
    // 5 °C gap; the bug TODO cites runs landing in the 5–7 °C band).
    // Temperature stays at 58 °C (7 °C gap, strictly greater than the
    // 5 °C `NEAR_TARGET_TEMPERATURE_DELTA_C` threshold) while power
    // cycles on and off over the 20-min window.
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    const cursor = driveCycling(state, {
      startMs: t0,
      tempC: 58,
      targetC: 65,
      durationMs: CAPPED_IDLE_MIN_WINDOW_MS,
      stepMs: 30_000,
      onPowerKw: 1.2,
    });
    const result = classifyIdleState(
      baseInput({
        now: cursor,
        measuredPowerKw: 0,
        currentTemperature: 58,
        targetTemperature: 65,
      }),
      state,
    );
    expect(result.classification).toBe('capped_idle');
    expect(result.temperatureGapC).toBe(7);
  });

  it('does NOT classify as capped_idle when power is monotonically low (unresponsive shape)', () => {
    // No on-cycles at all → cycling check fails → falls back through to
    // the existing eligibility / unresponsive path. Temperature 55 °C
    // against 65 °C target (10 °C gap, > 5 °C band) after the 15-min
    // unresponsive window → `unresponsive`.
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    const cold = baseInput({ currentTemperature: 55 });
    classifyIdleState({ ...cold, now: t0 }, state);
    const result = classifyIdleState(
      { ...cold, now: t0 + IDLE_UNRESPONSIVE_MIN_DURATION_MS + 1_000 },
      state,
    );
    expect(result.classification).toBe('unresponsive');
  });

  it('does NOT classify as capped_idle when the gap is within the near-target band', () => {
    // Same cycling + stable temperature shape, but the gap is below 5 °C
    // — `capped_idle` is reserved for the gap-too-big case. Cycling
    // disrupts the contiguous `idleSinceMs` streak, so the existing
    // `near_target_idle` path can't fire either (it requires sustained
    // measured-idle). This branch deliberately falls through to `active`
    // — the classifier doesn't model "satisfied while cycling inside the
    // hysteresis band" since real heaters don't do that.
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    const cursor = driveCycling(state, {
      startMs: t0,
      tempC: 63, // gap 2 °C — inside the near-target band
      targetC: 65,
      durationMs: CAPPED_IDLE_MIN_WINDOW_MS,
      stepMs: 30_000,
      onPowerKw: 1.2,
    });
    const result = classifyIdleState(
      baseInput({
        now: cursor,
        measuredPowerKw: 0,
        currentTemperature: 63,
        targetTemperature: 65,
      }),
      state,
    );
    expect(result.classification).not.toBe('capped_idle');
  });

  it('does NOT classify as capped_idle when temperature is climbing through the window', () => {
    // A heater that is genuinely heating (rate-limited charging) will
    // shift its temperature reading across the window. The stable-temp
    // check must reject this shape so an actively-climbing device isn't
    // labelled "capped" while it's still making progress.
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    let cursor = t0;
    let temp = 55;
    let drawing = true;
    while (cursor <= t0 + CAPPED_IDLE_MIN_WINDOW_MS) {
      classifyIdleState(
        baseInput({
          now: cursor,
          measuredPowerKw: drawing ? 1.5 : 0,
          currentTemperature: temp,
          targetTemperature: 65,
        }),
        state,
      );
      cursor += 30_000;
      drawing = !drawing;
      temp += 0.15; // climbs > 1 °C across the window
    }
    const result = classifyIdleState(
      baseInput({
        now: cursor,
        measuredPowerKw: 0,
        currentTemperature: temp,
        targetTemperature: 65,
      }),
      state,
    );
    expect(result.classification).not.toBe('capped_idle');
  });

  it('does NOT fire on a half-populated window during the first ticks', () => {
    // Just one cycling pair inside the first 5 min — the cycling +
    // stability signature is plausible but the window isn't fully
    // populated yet. Producer-side guard: `capped_idle` is reserved for
    // the case where the *full* 20-min window agrees.
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    classifyIdleState(
      baseInput({ now: t0, measuredPowerKw: 1.2, currentTemperature: 60, targetTemperature: 65 }),
      state,
    );
    classifyIdleState(
      baseInput({ now: t0 + 60_000, measuredPowerKw: 0, currentTemperature: 60, targetTemperature: 65 }),
      state,
    );
    const result = classifyIdleState(
      baseInput({ now: t0 + 120_000, measuredPowerKw: 0, currentTemperature: 60, targetTemperature: 65 }),
      state,
    );
    expect(result.classification).not.toBe('capped_idle');
  });

  it('does NOT fire on a single brief on-burst followed by 19 min of silence', () => {
    // Real failure mode the two-halves cycling rule guards against: a
    // tripped breaker mid-burst, child-lock engaged mid-cycle, or a relay
    // failure. The device draws for one brief tick at t=0 then goes
    // silent for the rest of the 20-min window. The premise that a
    // truly-off heater would drop > 1 °C in 18 min does NOT hold for a
    // 200L water heater (Connected 300, the canonical reproducer), so
    // the stable-temp check alone is not enough — without the two-halves
    // cycling requirement, this shape would have falsely promoted to
    // `capped_idle` and silently called a stuck device "succeeded",
    // which is the failure mode `unresponsive → null` was designed to
    // prevent.
    const state: IdleDetectorState = new Map();
    const t0 = 1_000_000;
    // First-half: one drawing tick at t=0, then immediate silence.
    classifyIdleState(
      baseInput({ now: t0, measuredPowerKw: 1.2, currentTemperature: 58, targetTemperature: 65 }),
      state,
    );
    // Second-half: nothing but idle samples for the rest of the window.
    let cursor = t0 + 60_000;
    while (cursor <= t0 + CAPPED_IDLE_MIN_WINDOW_MS) {
      classifyIdleState(
        baseInput({
          now: cursor,
          measuredPowerKw: 0,
          currentTemperature: 58, // tank thermal mass holds temp inside the 1 °C band
          targetTemperature: 65,
        }),
        state,
      );
      cursor += 60_000;
    }
    const result = classifyIdleState(
      baseInput({ now: cursor, measuredPowerKw: 0, currentTemperature: 58, targetTemperature: 65 }),
      state,
    );
    expect(result.classification).not.toBe('capped_idle');
  });
});

describe('pruneIdleDetectorState', () => {
  it('drops entries for device ids not in the live set', () => {
    const state: IdleDetectorState = new Map();
    state.set('keep', {
      idleSinceMs: 1,
      lastClassification: 'near_target_idle',
      samples: [],
      firstSampleAtMs: 1,
    });
    state.set('drop', {
      idleSinceMs: 2,
      lastClassification: 'unresponsive',
      samples: [],
      firstSampleAtMs: 2,
    });
    pruneIdleDetectorState(state, ['keep']);
    expect(state.has('keep')).toBe(true);
    expect(state.has('drop')).toBe(false);
  });
});
