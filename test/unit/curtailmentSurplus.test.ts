// Unit tests for the curtailment-surplus estimator (`lib/solar/curtailmentSurplus`):
// the producer math (inference formula, discounts, freshness/dormancy gates, the
// sticky import latch) and the outcome-based verification state machine (engage →
// confirmed / refuted + hold ladder / silent close). Pure class — deps are plain
// closures and every entry point takes an explicit `nowMs`, so no clock is faked.
import { describe, expect, it } from 'vitest';
import {
  CURTAIL_CONFIRM_STANDING_IMPORT_KW,
  CURTAIL_HOLD_BASE_MS,
  CURTAIL_IMPORT_HOLD_DOWN_MS,
  CURTAIL_NET_GATE_KW,
  CURTAIL_SAMPLE_FRESH_MS,
  CURTAIL_VERIFY_WINDOW_MS,
  CurtailmentSurplusEstimator,
  type CurtailmentHoldStore,
  type CurtailmentPersistedHoldState,
  type CurtailmentPotential,
} from '../../lib/solar/curtailmentSurplus';
// Test code may cross the plan↔solar boundary the runtime bans — that is the
// point: the constant pairing below has no shared runtime constant to enforce it.
import { SURPLUS_ABSORB_HARD_OFF_IMPORT_KW } from '../../lib/plan/admission/surplusAbsorb';

const T0 = Date.UTC(2026, 5, 19, 12, 0, 0); // hour-aligned noon
const TICK_MS = 10_000; // Homey Energy poll cadence

type Harness = {
  estimator: CurtailmentSurplusEstimator;
  events: Array<Record<string, unknown>>;
  ctl: {
    potential: CurtailmentPotential | null;
    battery: boolean;
    lift: boolean;
  };
};

const build = (
  potential: CurtailmentPotential | null = { kw: 3, confidence: 'high' },
  holdStore?: CurtailmentHoldStore,
): Harness => {
  const ctl = { potential, battery: false, lift: false };
  const events: Array<Record<string, unknown>> = [];
  const estimator = new CurtailmentSurplusEstimator({
    getPotential: () => ctl.potential,
    hasHomeBattery: () => ctl.battery,
    isSurplusLiftEngaged: () => ctl.lift,
    ...(holdStore ? { holdStore } : {}),
    logger: { info: (obj) => { events.push(obj); } },
  });
  return { estimator, events, ctl };
};

// Fold `count` co-samples at the poll cadence starting at `fromMs`; returns the
// timestamp of the LAST sample.
const ticks = (
  h: Harness,
  fromMs: number,
  count: number,
  netW: number,
  generationW: number | undefined = 500,
): number => {
  let last = fromMs;
  for (let i = 0; i < count; i += 1) {
    last = fromMs + i * TICK_MS;
    h.estimator.recordSample(netW, generationW, last);
  }
  return last;
};

const eventNames = (h: Harness): string[] => h.events.map((e) => String(e.event));

describe('CurtailmentSurplusEstimator — term math and gates', () => {
  it('stays dormant (term null) until the first POSITIVE generation sample', () => {
    const h = build();
    h.estimator.recordSample(0, 0, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull();
    h.estimator.recordSample(0, 500, T0 + TICK_MS);
    // 0.9 × 3 kW potential − 0.5 kW generation = 2.2 kW
    expect(h.estimator.getCurtailedSurplusKw(T0 + TICK_MS)).toBeCloseTo(2.2, 6);
  });

  it('yields null forever for flow-source homes (generationW undefined never arms)', () => {
    const h = build();
    for (let i = 0; i < 10; i += 1) {
      h.estimator.recordSample(0, undefined, T0 + i * TICK_MS);
    }
    expect(h.estimator.getCurtailedSurplusKw(T0 + 9 * TICK_MS)).toBeNull();
    expect(h.events).toHaveLength(0); // and never logs — non-solar byte-identical
  });

  it('suppresses the term while a home battery is tracked, and un-suppresses when it goes', () => {
    const h = build();
    h.estimator.recordSample(0, 500, T0);
    h.ctl.battery = true;
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull();
    h.ctl.battery = false;
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeCloseTo(2.2, 6);
  });

  it('expires the term when the co-sample goes stale (freshness window)', () => {
    const h = build();
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0 + CURTAIL_SAMPLE_FRESH_MS)).toBeCloseTo(2.2, 6);
    expect(h.estimator.getCurtailedSurplusKw(T0 + CURTAIL_SAMPLE_FRESH_MS + 1)).toBeNull();
  });

  it('yields null when the potential is unresolvable (no fit / no forecast hour)', () => {
    const h = build(null);
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull();
  });

  it('yields null on a non-finite potential (boundary guard on the injected dep)', () => {
    const h = build({ kw: Number.NaN, confidence: 'high' });
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull();
  });

  it('applies the low-confidence discount (0.8) vs the medium/high discount (0.9)', () => {
    const low = build({ kw: 3, confidence: 'low' });
    low.estimator.recordSample(0, 500, T0);
    expect(low.estimator.getCurtailedSurplusKw(T0)).toBeCloseTo(0.8 * 3 - 0.5, 6);
    const medium = build({ kw: 3, confidence: 'medium' });
    medium.estimator.recordSample(0, 500, T0);
    expect(medium.estimator.getCurtailedSurplusKw(T0)).toBeCloseTo(0.9 * 3 - 0.5, 6);
  });

  it('clamps the term at zero when actual generation meets the discounted potential', () => {
    const h = build();
    h.estimator.recordSample(0, 5_000, T0); // 5 kW generation > 0.9 × 3 kW
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBe(0);
  });

  it('drops a junk co-sample whole: no state write, no freshness bump', () => {
    const h = build();
    h.estimator.recordSample(0, 500, T0);
    h.estimator.recordSample(Number.NaN, 500, T0 + 40_000);
    h.estimator.recordSample(0, Number.POSITIVE_INFINITY, T0 + 41_000);
    // Freshness still anchored at T0 — the junk samples must not extend it.
    expect(h.estimator.getCurtailedSurplusKw(T0 + CURTAIL_SAMPLE_FRESH_MS + 1)).toBeNull();
  });
});

describe('CurtailmentSurplusEstimator — sticky import latch', () => {
  it('zeroes the term for the full hold-down after ONE gate-exceeding tick, despite net~0 ticks after', () => {
    const h = build();
    h.estimator.recordSample(0, 500, T0);
    const latchAt = T0 + TICK_MS;
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 0.1) * 1000, 500, latchAt);
    // Subsequent net~0 ticks keep the sample fresh but must NOT clear the latch.
    let t = latchAt;
    while (t < latchAt + CURTAIL_IMPORT_HOLD_DOWN_MS + TICK_MS) {
      t += TICK_MS;
      h.estimator.recordSample(0, 500, t);
      const withinLatch = t < latchAt + CURTAIL_IMPORT_HOLD_DOWN_MS;
      if (withinLatch) expect(h.estimator.getCurtailedSurplusKw(t)).toBeNull();
    }
    expect(h.estimator.getCurtailedSurplusKw(t)).toBeCloseTo(2.2, 6);
  });

  it('does not latch at the gate value itself (strictly above)', () => {
    const h = build();
    h.estimator.recordSample(CURTAIL_NET_GATE_KW * 1000, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeCloseTo(2.2, 6);
  });
});

describe('CurtailmentSurplusEstimator — outcome-based verification', () => {
  // Arm the estimator and engage the lift on a positive term (opens the window).
  const engage = (h: Harness, atMs: number): number => {
    const { ctl, estimator } = h;
    const last = ticks(h, atMs, 2, 0);
    ctl.lift = true;
    const engagedAt = last + TICK_MS;
    estimator.recordSample(0, 500, engagedAt);
    return engagedAt;
  };

  it('opens a verify window on the lift rising edge while the term is positive', () => {
    const h = build();
    engage(h, T0);
    expect(eventNames(h)).toContain('curtailment_verify_started');
  });

  it('does not open a window when the term is zero/null at the rising edge', () => {
    const h = build({ kw: 0.4, confidence: 'high' }); // 0.9×0.4 − 0.5 gen < 0 ⇒ term 0
    ticks(h, T0, 2, 0);
    h.ctl.lift = true;
    h.estimator.recordSample(0, 500, T0 + 2 * TICK_MS);
    expect(eventNames(h)).not.toContain('curtailment_verify_started');
  });

  it('opens THEN refutes when the first post-engage tick already imports (not a silent latch)', () => {
    // The heater starts between 10 s polls, so the very first sample after the
    // boost engages already shows import above the gate. The rising edge must be
    // processed BEFORE the import latch, so a window opens that the same tick's
    // import then refutes — otherwise the latch would null the term, no window
    // would ever open, and the false inference would escape the hold ladder.
    const h = build();
    const last = ticks(h, T0, 2, 0); // armed, lift still false
    h.ctl.lift = true;
    h.estimator.recordSample(2_000, 500, last + TICK_MS); // engage + immediate import
    expect(eventNames(h)).toContain('curtailment_verify_started');
    expect(eventNames(h)).toContain('curtailment_verify_refuted');
    const refutes = h.events.filter((e) => e.event === 'curtailment_verify_refuted');
    expect(refutes.at(-1)!.holdLevel).toBe(1);
    // And the term is on the hold ladder, not merely latched: it stays null past
    // the 90 s import latch, out to the 15-min hold.
    h.estimator.recordSample(0, 500, last + TICK_MS + CURTAIL_IMPORT_HOLD_DOWN_MS + TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(last + TICK_MS + CURTAIL_IMPORT_HOLD_DOWN_MS + TICK_MS)).toBeNull();
  });

  it('does not open a window if a lift was already engaged before the estimator armed (no spurious edge)', () => {
    // A raise can already be binding when the home first produces (e.g. a boost
    // financed by measured export before generation was ever seen). Arming must
    // seed the lift baseline to the CURRENT state, so the arming tick is not read
    // as a rising edge and no window opens on load the inference never financed.
    const h = build();
    h.ctl.lift = true; // already engaged before any production
    h.estimator.recordSample(0, 500, T0); // first positive generation → arms
    expect(eventNames(h)).not.toContain('curtailment_verify_started');
    // A genuine later drop + re-engage still verifies — the baseline is not stuck.
    h.ctl.lift = false;
    h.estimator.recordSample(0, 500, T0 + TICK_MS);
    h.ctl.lift = true;
    h.estimator.recordSample(0, 500, T0 + 2 * TICK_MS);
    expect(eventNames(h)).toContain('curtailment_verify_started');
  });

  it('CONFIRMS when the window expires without a refuting import, resetting the level', () => {
    const h = build();
    const engagedAt = engage(h, T0);
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, 0);
    expect(eventNames(h)).toContain('curtailment_verify_confirmed');
    expect(eventNames(h)).not.toContain('curtailment_verify_refuted');
  });

  it('REFUTES on an in-window import: term zeroed and the hold ladder escalates 15/30/60, capped', () => {
    const h = build();
    let at = T0;
    const observedHoldsMs: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const engagedAt = engage(h, at);
      // Import inside the window ⇒ refute.
      const refuteAt = engagedAt + TICK_MS;
      h.estimator.recordSample(2_000, 500, refuteAt);
      const refutes = h.events.filter((e) => e.event === 'curtailment_verify_refuted');
      expect(refutes).toHaveLength(round + 1);
      const holdMs = refutes[round]!.holdMs as number;
      observedHoldsMs.push(holdMs);
      // Term is zeroed through the whole hold.
      h.estimator.recordSample(0, 500, refuteAt + TICK_MS);
      expect(h.estimator.getCurtailedSurplusKw(refuteAt + TICK_MS)).toBeNull();
      // Re-arm: drop the lift, wait out the hold with clean samples, term returns.
      h.ctl.lift = false;
      const holdEndsAt = refuteAt + holdMs;
      h.estimator.recordSample(0, 500, holdEndsAt + TICK_MS);
      expect(h.estimator.getCurtailedSurplusKw(holdEndsAt + TICK_MS)).toBeCloseTo(2.2, 6);
      at = holdEndsAt + 2 * TICK_MS;
    }
    expect(observedHoldsMs).toEqual([
      CURTAIL_HOLD_BASE_MS,
      CURTAIL_HOLD_BASE_MS * 2,
      CURTAIL_HOLD_BASE_MS * 4,
      CURTAIL_HOLD_BASE_MS * 4, // level capped at 3
    ]);
  });

  it('a CONFIRMED verdict resets the ladder: the next refute holds 15 min again', () => {
    const h = build();
    // Round 1: refute (level 1, 15 min hold).
    let engagedAt = engage(h, T0);
    h.estimator.recordSample(2_000, 500, engagedAt + TICK_MS);
    h.ctl.lift = false;
    const holdEndsAt = engagedAt + TICK_MS + CURTAIL_HOLD_BASE_MS;
    // Round 2: confirm (window expires clean).
    engagedAt = engage(h, holdEndsAt + TICK_MS);
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, 0);
    expect(eventNames(h)).toContain('curtailment_verify_confirmed');
    h.ctl.lift = false;
    h.estimator.recordSample(0, 500, engagedAt + CURTAIL_VERIFY_WINDOW_MS + 5 * TICK_MS);
    // Round 3: refute again — the ladder restarted at 15 min.
    engagedAt = engage(h, engagedAt + CURTAIL_VERIFY_WINDOW_MS + 6 * TICK_MS);
    h.estimator.recordSample(2_000, 500, engagedAt + TICK_MS);
    const refutes = h.events.filter((e) => e.event === 'curtailment_verify_refuted');
    expect(refutes.at(-1)!.holdMs).toBe(CURTAIL_HOLD_BASE_MS);
    expect(refutes.at(-1)!.holdLevel).toBe(1);
  });

  it('closes the window silently on a lift falling edge (no verdict, level kept)', () => {
    const h = build();
    const engagedAt = engage(h, T0);
    h.ctl.lift = false;
    h.estimator.recordSample(0, 500, engagedAt + TICK_MS);
    // Later import (outside any window) must not count as a refute.
    h.estimator.recordSample(2_000, 500, engagedAt + 2 * TICK_MS);
    expect(eventNames(h)).not.toContain('curtailment_verify_refuted');
    expect(eventNames(h)).not.toContain('curtailment_verify_confirmed');
  });

  it('emits curtailment_term_state on transitions only, never per tick', () => {
    const h = build();
    ticks(h, T0, 6, 0); // six armed ticks in a row
    const stateEvents = h.events.filter((e) => e.event === 'curtailment_term_state');
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0]).toMatchObject({ state: 'armed', previousState: 'suppressed' });
  });

  it('does NOT confirm a window that expired during a sample outage (evidence-free expiry closes silently)', () => {
    const h = build();
    const engagedAt = engage(h, T0);
    // Total sample outage spanning the whole window; the first post-outage tick
    // lands after the deadline — importing hard, which historically confirmed.
    const afterDeadline = engagedAt + CURTAIL_VERIFY_WINDOW_MS + TICK_MS;
    h.estimator.recordSample(5_000, 500, afterDeadline);
    expect(eventNames(h)).not.toContain('curtailment_verify_confirmed');
    // Nor a refute: the window closed at its own deadline, before this tick's net.
    expect(eventNames(h)).not.toContain('curtailment_verify_refuted');
  });

  it('keeps the ladder level across an evidence-free expiry (a later refute escalates, not restarts)', () => {
    const h = build();
    // Round 1: refute → level 1.
    let engagedAt = engage(h, T0);
    h.estimator.recordSample(2_000, 500, engagedAt + TICK_MS);
    h.ctl.lift = false;
    const holdEndsAt = engagedAt + TICK_MS + CURTAIL_HOLD_BASE_MS;
    h.estimator.recordSample(0, 500, holdEndsAt + TICK_MS); // falling edge + re-arm
    // Round 2: engage, then an outage spans the window — silent close, no verdict.
    engagedAt = engage(h, holdEndsAt + 2 * TICK_MS);
    const afterDeadline = engagedAt + CURTAIL_VERIFY_WINDOW_MS + TICK_MS;
    h.estimator.recordSample(0, 500, afterDeadline); // clean tick, stale evidence
    expect(h.events.filter((e) => e.event === 'curtailment_verify_confirmed')).toHaveLength(0);
    // Round 3: refute again — the level kept by the silent close escalates to 2.
    h.ctl.lift = false;
    h.estimator.recordSample(0, 500, afterDeadline + TICK_MS);
    engagedAt = engage(h, afterDeadline + 2 * TICK_MS);
    h.estimator.recordSample(2_000, 500, engagedAt + TICK_MS);
    const refutes = h.events.filter((e) => e.event === 'curtailment_verify_refuted');
    expect(refutes.at(-1)!.holdMs).toBe(CURTAIL_HOLD_BASE_MS * 2);
    expect(refutes.at(-1)!.holdLevel).toBe(2);
  });

  it('withholds CONFIRM when the window was financed by measured export (inference not load-bearing)', () => {
    const h = build();
    const engagedAt = engage(h, T0);
    // The home exports beyond the gate band throughout the window: the lift ran
    // on measured export, proving nothing about the inferred term.
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, -500);
    expect(eventNames(h)).not.toContain('curtailment_verify_confirmed');
    expect(eventNames(h)).not.toContain('curtailment_verify_refuted');
  });

  it('an export-financed window does not reset the ladder (the next refute escalates)', () => {
    const h = build();
    // Round 1: refute → level 1.
    let engagedAt = engage(h, T0);
    h.estimator.recordSample(2_000, 500, engagedAt + TICK_MS);
    h.ctl.lift = false;
    const holdEndsAt = engagedAt + TICK_MS + CURTAIL_HOLD_BASE_MS;
    h.estimator.recordSample(0, 500, holdEndsAt + TICK_MS);
    // Round 2: export-financed window runs to expiry — no reset.
    engagedAt = engage(h, holdEndsAt + 2 * TICK_MS);
    const last = ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, -500);
    expect(h.events.filter((e) => e.event === 'curtailment_verify_confirmed')).toHaveLength(0);
    // Round 3: refute — level continues from 1 → 2 (30 min), not back to 15.
    h.ctl.lift = false;
    h.estimator.recordSample(0, 500, last + TICK_MS);
    engagedAt = engage(h, last + 2 * TICK_MS);
    h.estimator.recordSample(2_000, 500, engagedAt + TICK_MS);
    const refutes = h.events.filter((e) => e.event === 'curtailment_verify_refuted');
    expect(refutes.at(-1)!.holdMs).toBe(CURTAIL_HOLD_BASE_MS * 2);
  });

  it('withholds CONFIRM when the window sat at persistent sub-gate standing import (partial absorption)', () => {
    const h = build();
    const engagedAt = engage(h, T0);
    // 0.2 kW import all window: below the 0.30 latch gate (no refute) but above
    // the 0.15 standing-import allowance — the lift was only partially absorbed.
    const standingImportW = (CURTAIL_CONFIRM_STANDING_IMPORT_KW + 0.05) * 1000;
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, standingImportW);
    expect(eventNames(h)).not.toContain('curtailment_verify_confirmed');
    expect(eventNames(h)).not.toContain('curtailment_verify_refuted');
  });

  it('CONFIRMS when the window net came down to within the standing-import allowance', () => {
    const h = build();
    const engagedAt = engage(h, T0);
    const withinAllowanceW = (CURTAIL_CONFIRM_STANDING_IMPORT_KW - 0.05) * 1000; // 0.1 kW
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, withinAllowanceW);
    expect(eventNames(h)).toContain('curtailment_verify_confirmed');
  });
});

describe('CurtailmentSurplusEstimator — gate pairing invariants', () => {
  it('the producer import gate sits strictly below the plan gate hard-off bar', () => {
    // The producer must stop feeding the inferred term BEFORE the surplus gate's
    // hard-off backstop trips (no churn band between them). Both constants are
    // dogfood-tunable, live on opposite sides of a dep-cruiser-banned edge, and
    // share no runtime constant — this assertion is the pairing's ONLY enforcement.
    expect(CURTAIL_NET_GATE_KW).toBeLessThan(SURPLUS_ABSORB_HARD_OFF_IMPORT_KW);
  });

  it('the confirm standing-import allowance sits strictly below the latch gate', () => {
    // A window that never latched must still be able to fail the absorption
    // check — the allowance losing to the gate is what creates that band.
    expect(CURTAIL_CONFIRM_STANDING_IMPORT_KW).toBeLessThan(CURTAIL_NET_GATE_KW);
  });
});

describe('CurtailmentSurplusEstimator — two-channel ingest (gen outage)', () => {
  const engage = (h: Harness, atMs: number): number => {
    const { ctl, estimator } = h;
    const last = ticks(h, atMs, 2, 0);
    ctl.lift = true;
    const engagedAt = last + TICK_MS;
    estimator.recordSample(0, 500, engagedAt);
    return engagedAt;
  };

  it('an import during a generation-read outage still latches the term', () => {
    const h = build();
    h.estimator.recordSample(0, 500, T0); // arm
    // Gen channel blinks; net shows sub-refute import above the gate.
    h.estimator.recordSample(400, undefined, T0 + TICK_MS);
    // Gen returns with net clean — the latch from the outage tick must hold.
    h.estimator.recordSample(0, 500, T0 + 2 * TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(T0 + 2 * TICK_MS)).toBeNull();
    // ...and expire on schedule.
    const latchEndsAt = T0 + TICK_MS + CURTAIL_IMPORT_HOLD_DOWN_MS;
    h.estimator.recordSample(0, 500, latchEndsAt + TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(latchEndsAt + TICK_MS)).toBeCloseTo(2.2, 6);
  });

  it('an open verify window refutes on a gen-outage import tick', () => {
    const h = build();
    const engagedAt = engage(h, T0);
    h.estimator.recordSample(2_000, undefined, engagedAt + TICK_MS); // gen blind, net imports
    expect(eventNames(h)).toContain('curtailment_verify_refuted');
  });

  it('a gen-outage tick bumps no term freshness (term stales fail-closed)', () => {
    const h = build();
    h.estimator.recordSample(0, 500, T0); // arm
    // Net-only ticks keep arriving well past the freshness window.
    h.estimator.recordSample(0, undefined, T0 + CURTAIL_SAMPLE_FRESH_MS);
    h.estimator.recordSample(0, undefined, T0 + CURTAIL_SAMPLE_FRESH_MS + TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(T0 + CURTAIL_SAMPLE_FRESH_MS + TICK_MS)).toBeNull();
  });
});

describe('CurtailmentSurplusEstimator — persisted refute ladder (crash-loop resilience)', () => {
  const fakeStore = (initial: CurtailmentPersistedHoldState | null): {
    store: CurtailmentHoldStore;
    writes: CurtailmentPersistedHoldState[];
  } => {
    const writes: CurtailmentPersistedHoldState[] = [];
    return {
      store: { read: () => initial, write: (state) => { writes.push(state); } },
      writes,
    };
  };

  it('a rehydrated hold blocks arming after a simulated restart until it expires', () => {
    const holdUntilMs = T0 + 10 * 60_000;
    const { store } = fakeStore({ holdLevel: 2, holdUntilMs, importLatchUntilMs: null });
    const h = build(undefined, store); // "restarted" estimator
    h.estimator.recordSample(0, 500, T0); // arms (dormancy is not persisted)
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull(); // hold live across the restart
    h.estimator.recordSample(0, 500, holdUntilMs + TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(holdUntilMs + TICK_MS)).toBeCloseTo(2.2, 6); // expiry honored
  });

  it('a rehydrated ladder keeps escalating: the next refute jumps past the restart level', () => {
    // Hold already expired before the restart — only the level survives.
    const { store, writes } = fakeStore({ holdLevel: 2, holdUntilMs: T0 - 1, importLatchUntilMs: null });
    const h = build(undefined, store);
    const last = ticks(h, T0, 2, 0);
    h.ctl.lift = true;
    const engagedAt = last + TICK_MS;
    h.estimator.recordSample(0, 500, engagedAt);
    h.estimator.recordSample(2_000, 500, engagedAt + TICK_MS); // refute: level 2 → 3
    const refutes = h.events.filter((e) => e.event === 'curtailment_verify_refuted');
    expect(refutes.at(-1)!.holdLevel).toBe(3);
    expect(refutes.at(-1)!.holdMs).toBe(CURTAIL_HOLD_BASE_MS * 4);
    expect(writes.at(-1)).toMatchObject({ holdLevel: 3 });
  });

  it('a rehydrated import latch stays live across the restart', () => {
    const latchUntilMs = T0 + 60_000;
    const { store } = fakeStore({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: latchUntilMs });
    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull(); // latched
    h.estimator.recordSample(0, 500, latchUntilMs + TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(latchUntilMs + TICK_MS)).toBeCloseTo(2.2, 6);
  });

  it('a null store read (junk blob normalized upstream) starts fresh', () => {
    const { store } = fakeStore(null);
    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeCloseTo(2.2, 6);
  });

  it('persists on transitions only: latch onset writes once, 10 s re-extensions do not', () => {
    const { store, writes } = fakeStore(null);
    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arm — no write
    expect(writes).toHaveLength(0);
    ticks(h, T0 + TICK_MS, 5, 2_000); // import episode: onset + 4 re-extensions
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ holdLevel: 0 });
    expect(writes[0]!.importLatchUntilMs).toBe(T0 + TICK_MS + CURTAIL_IMPORT_HOLD_DOWN_MS);
  });

  it('a level-resetting confirm persists the reset', () => {
    const { store, writes } = fakeStore({ holdLevel: 1, holdUntilMs: T0 - 1, importLatchUntilMs: null });
    const h = build(undefined, store);
    const last = ticks(h, T0, 2, 0);
    h.ctl.lift = true;
    const engagedAt = last + TICK_MS;
    h.estimator.recordSample(0, 500, engagedAt); // window opens
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, 0);
    expect(eventNames(h)).toContain('curtailment_verify_confirmed');
    expect(writes.at(-1)).toMatchObject({ holdLevel: 0 });
  });
});
