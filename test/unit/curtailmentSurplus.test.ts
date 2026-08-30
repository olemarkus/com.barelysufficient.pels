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
  type CurtailmentHoldRead,
  type CurtailmentHoldStore,
  type CurtailmentPersistedHoldState,
  type CurtailmentPotentialRead,
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
    potential: CurtailmentPotentialRead;
    battery: boolean;
    lift: boolean;
  };
};

const build = (
  potential: CurtailmentPotentialRead = { kind: 'resolved', potential: { kw: 3, confidence: 'high' } },
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

  describe('canContributeSurplus (standing capability, not the current term)', () => {
    // Gates the `surplusOnly` posture via `resolveSurplusPoolReachable`. It must
    // answer "could a term ever arrive here?", NOT "is there one now" — the
    // transient nulls come and go by the minute, and a posture that tracked them
    // would flap a dump load on and off all afternoon.
    it('is false while dormant — no positive co-temporal generation seen yet', () => {
      const h = build();
      expect(h.estimator.canContributeSurplus()).toBe(false);
      h.estimator.recordSample(0, 500, T0);
      expect(h.estimator.canContributeSurplus()).toBe(true);
    });

    it('stays dormant when generation is absent, as on a source with no co-temporal reading', () => {
      const h = build();
      h.estimator.recordSample(0, undefined, T0);
      expect(h.estimator.canContributeSurplus()).toBe(false);
    });

    it('is false in a battery home — the term is suppressed outright in v1', () => {
      const h = build();
      h.estimator.recordSample(0, 500, T0);
      h.ctl.battery = true;
      expect(h.estimator.canContributeSurplus()).toBe(false);
    });

    it('ignores the TRANSIENT suppressors, which the term itself honours', () => {
      // A stale co-sample nulls the term but says nothing about capability.
      const h = build();
      h.estimator.recordSample(0, 500, T0);
      const stale = T0 + CURTAIL_SAMPLE_FRESH_MS + 1;
      expect(h.estimator.getCurtailedSurplusKw(stale)).toBeNull();
      expect(h.estimator.canContributeSurplus()).toBe(true);

      // So does the sticky import latch.
      h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, T0 + TICK_MS);
      expect(h.estimator.getCurtailedSurplusKw(T0 + TICK_MS)).toBeNull();
      expect(h.estimator.canContributeSurplus()).toBe(true);
    });
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
    const h = build({ kind: 'unresolvable' });
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull();
  });

  it('yields null on a non-finite potential (boundary guard on the injected dep)', () => {
    const h = build({ kind: 'resolved', potential: { kw: Number.NaN, confidence: 'high' } });
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull();
  });

  it('applies the low-confidence discount (0.8) vs the medium/high discount (0.9)', () => {
    const low = build({ kind: 'resolved', potential: { kw: 3, confidence: 'low' } });
    low.estimator.recordSample(0, 500, T0);
    expect(low.estimator.getCurtailedSurplusKw(T0)).toBeCloseTo(0.8 * 3 - 0.5, 6);
    const medium = build({ kind: 'resolved', potential: { kw: 3, confidence: 'medium' } });
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
    const h = build({ kind: 'resolved', potential: { kw: 0.4, confidence: 'high' } }); // 0.9×0.4 − 0.5 gen < 0 ⇒ term 0
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
  const loaded = (value: CurtailmentPersistedHoldState): CurtailmentHoldRead => ({ state: 'loaded', value });

  const fakeStore = (initial: CurtailmentHoldRead): {
    store: CurtailmentHoldStore;
    writes: CurtailmentPersistedHoldState[];
  } => {
    const writes: CurtailmentPersistedHoldState[] = [];
    return {
      store: {
        read: () => initial,
        write: (state) => { writes.push(state); return true; },
      },
      writes,
    };
  };

  // Read-your-writes, so a second estimator over the same store models a restart.
  const roundTripStore = (): CurtailmentHoldStore & { disk: CurtailmentHoldRead } => {
    const store = {
      disk: { state: 'absent' } as CurtailmentHoldRead,
      read: (): CurtailmentHoldRead => store.disk,
      write: (next: CurtailmentPersistedHoldState) => { store.disk = loaded(next); return true; },
    };
    return store;
  };

  it('never overwrites a retained ladder after an UNREADABLE boot read', () => {
    // The destructive-reset hazard. A thrown settings read is not "nothing
    // stored": writing this instance's blank ladder over the retained one would
    // reset the refute escalation on a transient failure, which the
    // abandon-grace rule forbids. Instead the write is withheld and the read
    // retried, so a store that recovers hands back the real ladder.
    let failing = true;
    const retained = { holdLevel: 2, holdUntilMs: T0 + 60_000, importLatchUntilMs: null };
    const writes: CurtailmentPersistedHoldState[] = [];
    const store: CurtailmentHoldStore = {
      read: () => (failing ? { state: 'unreadable' } : { state: 'loaded', value: retained }),
      write: (state) => { writes.push(state); return true; },
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arms — but the store is still blind
    expect(writes).toHaveLength(0);

    // The store recovers: the retained ladder is adopted, not clobbered.
    failing = false;
    h.estimator.recordSample(0, 500, T0 + TICK_MS);
    expect(writes.at(-1)).toMatchObject({ holdLevel: 2, armed: true });
    expect(writes.at(-1)!.holdUntilMs).toBe(retained.holdUntilMs);
  });

  it('keeps LOCAL ladder evidence when the store resolves after a refute', () => {
    // The other ordering, and the one a naive merge gets wrong. During the
    // outage this instance refutes and sets its own 15-minute hold. When the
    // store finally answers, its ladder is stale by construction — folding it in
    // would re-extend a hold from a previous session and then persist the blend.
    // Local wins outright, and the abandon-grace window ends the moment there is
    // first-hand evidence, so the write is no longer withheld.
    let failing = true;
    const retained = { holdLevel: 3, holdUntilMs: T0 + 50 * 60_000, importLatchUntilMs: null };
    const writes: CurtailmentPersistedHoldState[] = [];
    const store: CurtailmentHoldStore = {
      read: () => (failing ? { state: 'unreadable' } : { state: 'loaded', value: retained }),
      write: (state) => { writes.push(state); return true; },
    };

    const h = build(undefined, store);
    // Arm, engage a lift, open a window, then refute it with a real import.
    h.estimator.recordSample(0, 500, T0);
    h.ctl.lift = true;
    h.estimator.recordSample(0, 500, T0 + TICK_MS);
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, T0 + 2 * TICK_MS);
    expect(eventNames(h)).toContain('curtailment_verify_refuted');
    // The refute IS first-hand evidence, so the grace window ends there and the
    // write is no longer withheld: level 1 from this session's single refute,
    // never 3 from disk, and the local 15-minute hold.
    expect(writes.at(-1)).toMatchObject({ holdLevel: 1, armed: true });
    expect(writes.at(-1)!.holdUntilMs).toBe(T0 + 2 * TICK_MS + CURTAIL_HOLD_BASE_MS);

    // And a store that recovers afterwards cannot resurrect the stale ladder.
    failing = false;
    h.estimator.recordSample(0, 500, T0 + 3 * TICK_MS);
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, T0 + 20 * TICK_MS);
    expect(writes.at(-1)).toMatchObject({ holdLevel: 1 });
  });

  it('persists a CONFIRMED reset of an ADOPTED ladder', () => {
    // Same rule, opposite direction. The level here came from disk, so nothing
    // is locally mutated until the confirm — which must both reset the ladder
    // and write the reset, rather than leaving disk at the old level.
    const writes: CurtailmentPersistedHoldState[] = [];
    const store: CurtailmentHoldStore = {
      read: () => ({
        state: 'loaded',
        value: { holdLevel: 3, holdUntilMs: T0 - 1, importLatchUntilMs: null },
      }),
      write: (state) => { writes.push(state); return true; },
    };

    const h = build(undefined, store);
    const last = ticks(h, T0, 2, 0);
    h.ctl.lift = true;
    const engagedAt = last + TICK_MS;
    h.estimator.recordSample(0, 500, engagedAt); // window opens
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, 0);
    expect(eventNames(h)).toContain('curtailment_verify_confirmed');
    expect(writes.at(-1)).toMatchObject({ holdLevel: 0 });
  });

  it('retries an arming write that the store dropped', () => {
    // A swallowed write leaves `dormant` cleared in memory and nothing on disk —
    // invisible until the restart the latch exists to survive. Later gen-valid
    // samples retry until it lands.
    let accepting = false;
    const writes: CurtailmentPersistedHoldState[] = [];
    const store: CurtailmentHoldStore = {
      read: () => ({ state: 'absent' }),
      write: (state) => { if (accepting) writes.push(state); return accepting; },
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0);
    expect(writes).toHaveLength(0);
    expect(h.estimator.canContributeSurplus()).toBe(true);

    accepting = true;
    h.estimator.recordSample(0, 500, T0 + TICK_MS);
    expect(writes.at(-1)).toMatchObject({ armed: true });

    // ...and stops retrying once it has landed.
    const after = writes.length;
    h.estimator.recordSample(0, 500, T0 + 2 * TICK_MS);
    expect(writes).toHaveLength(after);
  });

  it('carries the ARMED latch across a restart', () => {
    // THE case this half of the persisted slice exists for. Dormancy lifts only
    // on a POSITIVE co-temporal generation reading, so a restart after dark
    // would not re-arm until sunrise — and the zero-export home this estimator
    // serves has no export evidence to cover the gap. Unstamped is not passive:
    // the generic managed-binary restore lane turns the dump load ON from grid
    // headroom, so the feature would invert overnight on every app update.
    const store = roundTripStore();
    const armed = build(undefined, store);
    armed.estimator.recordSample(0, 500, T0);
    expect(armed.estimator.canContributeSurplus()).toBe(true);
    expect(store.disk).toMatchObject({ state: 'loaded', value: { armed: true } });

    expect(build(undefined, store).estimator.canContributeSurplus()).toBe(true);
  });

  it('does not arm from a blob written before the latch existed', () => {
    // Absence is "not proven", never a fabricated capability — it costs one
    // production sample to re-earn.
    const store = roundTripStore();
    store.disk = loaded({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null });
    expect(build(undefined, store).estimator.canContributeSurplus()).toBe(false);
  });

  it('a rehydrated hold blocks arming after a simulated restart until it expires', () => {
    const holdUntilMs = T0 + 10 * 60_000;
    const { store } = fakeStore(loaded({ holdLevel: 2, holdUntilMs, importLatchUntilMs: null }));
    const h = build(undefined, store); // "restarted" estimator
    h.estimator.recordSample(0, 500, T0); // arms (dormancy is not persisted)
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull(); // hold live across the restart
    h.estimator.recordSample(0, 500, holdUntilMs + TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(holdUntilMs + TICK_MS)).toBeCloseTo(2.2, 6); // expiry honored
  });

  it('a rehydrated ladder keeps escalating: the next refute jumps past the restart level', () => {
    // Hold already expired before the restart — only the level survives.
    const { store, writes } = fakeStore(loaded({ holdLevel: 2, holdUntilMs: T0 - 1, importLatchUntilMs: null }));
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
    const { store } = fakeStore(loaded({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: latchUntilMs }));
    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeNull(); // latched
    h.estimator.recordSample(0, 500, latchUntilMs + TICK_MS);
    expect(h.estimator.getCurtailedSurplusKw(latchUntilMs + TICK_MS)).toBeCloseTo(2.2, 6);
  });

  it('an ABSENT store read (unset key or junk blob condemned upstream) starts fresh', () => {
    const { store } = fakeStore({ state: 'absent' });
    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0);
    expect(h.estimator.getCurtailedSurplusKw(T0)).toBeCloseTo(2.2, 6);
  });

  it('persists on transitions only: arming and latch onset write once each, re-extensions do not', () => {
    // The rule is "never per tick", not "never on arming". Arming happens once
    // per install, and it MUST be written: the armed latch is what carries the
    // home's capability across a restart.
    const { store, writes } = fakeStore({ state: 'absent' });
    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arm — one write, the latch
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ armed: true, holdLevel: 0 });
    ticks(h, T0 + TICK_MS, 5, 2_000); // import episode: onset + 4 re-extensions
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ holdLevel: 0 });
    expect(writes[1]!.importLatchUntilMs).toBe(T0 + TICK_MS + CURTAIL_IMPORT_HOLD_DOWN_MS);
  });

  it('a level-resetting confirm persists the reset', () => {
    const { store, writes } = fakeStore(loaded({ holdLevel: 1, holdUntilMs: T0 - 1, importLatchUntilMs: null }));
    const h = build(undefined, store);
    const last = ticks(h, T0, 2, 0);
    h.ctl.lift = true;
    const engagedAt = last + TICK_MS;
    h.estimator.recordSample(0, 500, engagedAt); // window opens
    ticks(h, engagedAt + TICK_MS, Math.ceil(CURTAIL_VERIFY_WINDOW_MS / TICK_MS) + 2, 0);
    expect(eventNames(h)).toContain('curtailment_verify_confirmed');
    expect(writes.at(-1)).toMatchObject({ holdLevel: 0 });
  });

  it('a latch ONSET during an UNREADABLE boot read persists nothing — the blank ladder never lands', () => {
    // The recorded defect (TODO "Curtailment hold-state read failure resets the
    // refute ladder"): a latch onset is a transition, but its write carries
    // `holdLevel: 0`. Ending the abandon-grace on it stamped that blank over
    // the retained ladder — a 60-min hold reset to 15-min on the next refute.
    // A latch onset is NOT ladder evidence: the write stays suppressed, the
    // in-memory latch still guards the term, and a recovering read adopts the
    // retained ladder.
    let failing = true;
    const retained = { holdLevel: 3, holdUntilMs: T0 + 30 * 60_000, importLatchUntilMs: null };
    const writes: CurtailmentPersistedHoldState[] = [];
    const store: CurtailmentHoldStore = {
      read: () => (failing ? { state: 'unreadable' } : { state: 'loaded', value: retained }),
      write: (state) => { writes.push(state); return true; },
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arms — suppressed
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, T0 + TICK_MS); // latch ONSET
    expect(writes).toHaveLength(0);
    // The latch itself still guards the term in memory.
    expect(h.estimator.getCurtailedSurplusKw(T0 + TICK_MS)).toBeNull();

    // The store recovers: the RETAINED ladder is adopted (level 3), and every
    // write from here carries it — never this instance's blank 0.
    failing = false;
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, T0 + 2 * TICK_MS);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.holdLevel === 3)).toBe(true);
    expect(writes.at(-1)).toMatchObject({ holdLevel: 3, armed: true });
  });

  it('suppresses the blank-ladder persist for the WHOLE process lifetime when the read never recovers', () => {
    // Reads stay down while writes would land — `settings.get` and `.set` fail
    // independently, which is exactly the TODO hazard. Every transition this
    // session carries `holdLevel: 0`, so nothing may ever be written: the next
    // clean restart must rehydrate the untouched on-disk blob.
    const writes: CurtailmentPersistedHoldState[] = [];
    const store: CurtailmentHoldStore = {
      read: () => ({ state: 'unreadable' }),
      write: (state) => { writes.push(state); return true; },
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arming persist — suppressed
    ticks(h, T0 + TICK_MS, 3, (CURTAIL_NET_GATE_KW + 1) * 1000); // latch onset + re-extensions
    // A SECOND onset after the first latch fully expires — still suppressed:
    // the suppression is for the process lifetime, not just the first write.
    const afterExpiry = T0 + 3 * TICK_MS + CURTAIL_IMPORT_HOLD_DOWN_MS + TICK_MS;
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, afterExpiry);
    expect(writes).toHaveLength(0);
  });

  it('a recovering read never truncates a live in-memory import latch (later deadline wins)', () => {
    // The latch is sticky BECAUSE "not importing at this instant" is not
    // proof: a short spike latches in-memory during the outage, and the store
    // recovers on the next tick with the typical retained blob (armed, no
    // latch, no hold) AFTER the import already ceased. Wholesale adoption
    // would trim the 90 s hold-down to one poll interval; the later of the
    // two deadlines wins instead.
    let failing = true;
    const retained = { holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: true };
    const store: CurtailmentHoldStore = {
      read: () => (failing ? { state: 'unreadable' } : { state: 'loaded', value: retained }),
      write: () => true,
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arms
    const spikeAt = T0 + TICK_MS;
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, spikeAt); // latch until spikeAt + 90 s
    failing = false;
    h.estimator.recordSample(0, 500, spikeAt + TICK_MS); // import ceased; store recovers
    // Still inside the LOCAL hold-down: the adopted blank latch must not lift it.
    expect(h.estimator.getCurtailedSurplusKw(spikeAt + 2 * TICK_MS)).toBeNull();
    // ...and the local deadline still expires on its own clock.
    const afterHoldDown = spikeAt + CURTAIL_IMPORT_HOLD_DOWN_MS + TICK_MS;
    h.estimator.recordSample(0, 500, afterHoldDown);
    expect(h.estimator.getCurtailedSurplusKw(afterHoldDown)).toBeCloseTo(2.2, 6);
  });

  it('persists the merged latch when adoption keeps a LATER in-memory deadline than the disk', () => {
    // The kept-local merge must reach disk. Adopting an ARMED blob quiets the
    // arming retry (armedPersisted), and later importing ticks see an
    // already-active latch (onset persists are edge-only) — so without a
    // persist on the adoption edge the newer deadline lives only in memory,
    // and a restart inside the remaining hold-down reloads the stale one,
    // exposing inferred surplus right after a real import.
    let failing = true;
    const writes: CurtailmentPersistedHoldState[] = [];
    const retained = { holdLevel: 1, holdUntilMs: T0 - 1, importLatchUntilMs: null, armed: true };
    const store: CurtailmentHoldStore = {
      read: () => (failing ? { state: 'unreadable' } : { state: 'loaded', value: retained }),
      write: (state) => { writes.push(state); return true; },
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arms (suppressed)
    const spikeAt = T0 + TICK_MS;
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, spikeAt); // local latch (suppressed)
    expect(writes).toHaveLength(0);

    failing = false;
    h.estimator.recordSample(0, 500, spikeAt + TICK_MS); // recovery: local deadline wins the merge
    expect(writes.at(-1)).toMatchObject({
      holdLevel: 1,
      importLatchUntilMs: spikeAt + CURTAIL_IMPORT_HOLD_DOWN_MS,
      armed: true,
    });

    // A restart inside the hold-down reloads the MERGED deadline, not null.
    const restarted = build(undefined, {
      read: () => ({ state: 'loaded', value: writes.at(-1)! }),
      write: () => true,
    });
    restarted.estimator.recordSample(0, 500, spikeAt + 3 * TICK_MS);
    expect(restarted.estimator.getCurtailedSurplusKw(spikeAt + 3 * TICK_MS)).toBeNull();
  });

  it('an ABSENT resolution persists suppressed local progress (armed + live latch) at once', () => {
    // While the disk was unknown, the arming and the latch onset were both
    // write-suppressed. When the retry resolves ABSENT (genuinely nothing on
    // disk), absence licenses the write — and nothing else would carry it:
    // the arming retry is gen-gated (dead at night) and the onset edge has
    // passed. A restart before the next gen-valid sample would lose the
    // active hold-down and the armed capability.
    let failingRead = true;
    const writes: CurtailmentPersistedHoldState[] = [];
    const store: CurtailmentHoldStore = {
      read: () => (failingRead ? { state: 'unreadable' } : { state: 'absent' }),
      write: (state) => { writes.push(state); return true; },
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arms (suppressed)
    const spikeAt = T0 + TICK_MS;
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, spikeAt); // latch onset (suppressed)
    expect(writes).toHaveLength(0);

    failingRead = false;
    // Resolution lands on a gen-INVALID (night) tick: the edge persist still fires.
    h.estimator.recordSample(0, undefined, spikeAt + TICK_MS);
    expect(writes.at(-1)).toMatchObject({
      holdLevel: 0,
      importLatchUntilMs: spikeAt + CURTAIL_IMPORT_HOLD_DOWN_MS,
      armed: true,
    });
  });

  it('retries a merged-latch write that failed on the adoption edge until it lands', () => {
    // Best-effort writes can fail on the adoption edge too — and by then the
    // ARMED adoption has quieted the arming retry, which is gen-gated anyway
    // (no generation ticks at night, exactly when latches are live). A
    // dedicated per-tick retry must carry the merged deadline to disk.
    let failingRead = true;
    let acceptingWrites = false;
    const writes: CurtailmentPersistedHoldState[] = [];
    const retained = { holdLevel: 2, holdUntilMs: T0 - 1, importLatchUntilMs: null, armed: true };
    const store: CurtailmentHoldStore = {
      read: () => (failingRead ? { state: 'unreadable' } : { state: 'loaded', value: retained }),
      write: (state) => { if (acceptingWrites) writes.push(state); return acceptingWrites; },
    };

    const h = build(undefined, store);
    h.estimator.recordSample(0, 500, T0); // arms (suppressed)
    const spikeAt = T0 + TICK_MS;
    h.estimator.recordSample((CURTAIL_NET_GATE_KW + 1) * 1000, 500, spikeAt); // local latch (suppressed)
    failingRead = false;
    h.estimator.recordSample(0, 500, spikeAt + TICK_MS); // adoption edge: the merge write FAILS
    expect(writes).toHaveLength(0);

    acceptingWrites = true;
    // Next tick is gen-INVALID (night): the per-tick retry still lands the merge.
    h.estimator.recordSample(0, undefined, spikeAt + 2 * TICK_MS);
    expect(writes.at(-1)).toMatchObject({
      holdLevel: 2,
      importLatchUntilMs: spikeAt + CURTAIL_IMPORT_HOLD_DOWN_MS,
      armed: true,
    });

    // The landed write cleared the flag: no further writes on quiet ticks.
    const after = writes.length;
    h.estimator.recordSample(0, undefined, spikeAt + 3 * TICK_MS);
    expect(writes).toHaveLength(after);
  });

  it('adoption-armed rehydration does not misread an already-engaged lift as a rising edge', () => {
    // A restart while a lift is ALREADY engaged (e.g. financed by measured
    // export): the armed bit rehydrates dormancy away in the constructor, so
    // the lift baseline must be seeded there exactly as the local arming path
    // seeds it — otherwise the first tick reads a rising edge and opens a
    // verify window on load the inference never financed, and any import
    // inside it escalates the persisted ladder on someone else's draw.
    const { store } = fakeStore(loaded({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: true }));
    const events: Array<Record<string, unknown>> = [];
    const estimator = new CurtailmentSurplusEstimator({
      getPotential: () => ({ kind: 'resolved', potential: { kw: 3, confidence: 'high' } }),
      hasHomeBattery: () => false,
      isSurplusLiftEngaged: () => true, // engaged since before this process
      holdStore: store,
      logger: { info: (obj) => { events.push(obj); } },
    });

    estimator.recordSample(0, 500, T0); // first tick: an ALREADY-engaged lift, not an edge
    expect(events.map((e) => String(e.event))).not.toContain('curtailment_verify_started');
  });
});
