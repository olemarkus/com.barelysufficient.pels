import {
  formatShortfallLine,
  isCeilingHoldReasonCode,
  resolveHeldCardReasonLine,
} from '../../shared-domain/src/planCardReasonLine.ts';
import { PLAN_REASON_CODES } from '../../shared-domain/src/planReasonSemanticsCore.ts';
import { PLAN_STATE_HELD_FALLBACK_STATUS } from '../../shared-domain/src/planStateLabels.ts';
import { toSimulationReasonLine } from '../../shared-domain/src/simulationReasonMood.ts';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi.ts';

// The duration is NBSP-joined so "2 h 15 min" cannot break across lines
// mid-figure at 320 px. Spelled out here rather than pasted invisibly, so a
// later edit cannot silently swap in an ordinary space.
const NBSP = '\u00a0';

const starvation = (
  accumulatedMs = 20 * 60 * 1000,
): SettingsUiPlanDeviceStarvation => ({
  isStarved: true,
  accumulatedMs,
  startedAtMs: Date.UTC(2026, 7, 2, 12, 0, 0),
});

describe('resolveHeldCardReasonLine', () => {
  // The governing rule: the card says what THIS device needs; the hero says
  // what is limiting the house. A card that named the ceiling repeated one
  // house-level fact once per device and answered nobody's question.
  describe('house-level ceilings never reach the card', () => {
    // Split by what the PRODUCER can actually supply, not by what the resolver
    // would do with a hand-built payload. Only these two reason shapes ever
    // carry admission arithmetic for the device itself: the `insufficientHeadroom`
    // hold computes it, and the `dailyBudget` re-attribution carries it across.
    it('states the shortfall for a re-attributed budget hold', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null, shortfallKw: 0.8 },
      })).toBe('Waiting to resume — 0.8 kW more needed');
    });

    it('states the shortfall for a headroom-blocked restore, computed from its margins', () => {
      expect(resolveHeldCardReasonLine({
        reason: {
          code: PLAN_REASON_CODES.insufficientHeadroom,
          needKw: 1.36,
          availableKw: 1.03,
          postReserveMarginKw: -0.58,
          minimumRequiredPostReserveMarginKw: 0.25,
          penaltyExtraKw: null,
          swapReserveKw: null,
          effectiveAvailableKw: null,
          swapTargetName: null,
        },
      })).toBe('Waiting to resume — 0.9 kW more needed');
    });

    // Since 2026-08-02 every power-liftable ceiling hold carries the device's
    // own gap: `finalizeCeilingReason` computes it each cycle when no producer
    // number exists — including for swap victims, where the attached number is
    // THIS device's need against the pace, never the swapped-in device's.
    it.each([
      PLAN_REASON_CODES.capacity,
      PLAN_REASON_CODES.swapPending,
      PLAN_REASON_CODES.swappedOut,
    ] as const)('%s with a normalizer-attached shortfall states the number', (code) => {
      expect(resolveHeldCardReasonLine({
        reason: { code, detail: null, targetName: null, shortfallKw: 1.2 },
      })).toBe('Waiting to resume — 1.2 kW more needed');
    });

    // The hour's kWh is spent and cannot be un-spent — no freed power admits
    // the device before the hour rolls over, so this is the one ceiling hold
    // whose line is time-based instead of a kW figure.
    it('renders time-based copy for an exhausted hourly budget, never a kW', () => {
      const line = resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.hourlyBudget, detail: null },
      });
      expect(line).toBe("Waiting to resume — this hour's budget is spent");
      expect(line).not.toMatch(/kW more needed/);
    });

    // Verb-aware like the shortfall line: a running stepped device denied a
    // step-up is not waiting to "resume".
    it('says "increase" for the hourly line on a step-up denial', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.hourlyBudget, detail: null },
        verb: 'increase',
      })).toBe("Waiting to increase — this hour's budget is spent");
    });

    // Bare fallback survivors: `sheddingActive` has no live producer (prose
    // parser + tests only), and a carrier without an attached number means the
    // arithmetic honestly declined (reserve block, or missing inputs).
    it.each([
      PLAN_REASON_CODES.capacity,
      PLAN_REASON_CODES.sheddingActive,
      PLAN_REASON_CODES.swapPending,
      PLAN_REASON_CODES.swappedOut,
    ] as const)('%s without a shortfall falls back to the bare waiting line', (code) => {
      const line = resolveHeldCardReasonLine({ reason: { code, detail: null, targetName: null } });
      expect(line).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
      expect(line).not.toMatch(/hard cap|budget|higher-priority/i);
    });

    it('falls back when a budget hold carries no shortfall', () => {
      expect(resolveHeldCardReasonLine({ reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null } }))
        .toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    });
  });

  // Holds where power is not the blocker keep their own copy: freeing power
  // would not start these devices, so a kW figure would be a lie.
  describe('non-power holds keep their own cause', () => {
    it('keeps the smart-task wait', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid, detail: null },
      })).toBe('Waiting for cheaper hours');
    });

    it('keeps the solar-surplus posture', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null },
      })).toBe('Waiting for solar surplus');
    });

    it('keeps the external-off recourse', () => {
      expect(resolveHeldCardReasonLine({ reason: { code: PLAN_REASON_CODES.externalOffHold } }))
        .toBe('Turned off elsewhere — turn it on to resume');
    });

    // The power IS available here — it is promised to a named device about to
    // start. A gap "through" the reservation is dominated by that device's
    // block, so naming the holder is the only honest line.
    it('names the holder for a startup reservation instead of a kW figure', () => {
      const line = resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.reservedForStart, targetName: 'Water heater' },
      });
      expect(line).toBe('Waiting so Water heater can start');
      expect(line).not.toContain('kW');
    });

    it('keeps the stepped fairness rule, which other devices resuming would lift', () => {
      expect(resolveHeldCardReasonLine({
        reason: {
          code: PLAN_REASON_CODES.shedInvariant,
          fromStep: '6a',
          toStep: '16a',
          shedDeviceCount: 2,
          maxStep: '10a',
        },
      })).toBe('Holding at 6 A — cannot increase while 2 devices are limited');
    });

    it('keeps countdown copy rather than a number that would not start the device', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 50 },
      })).toBe('Waiting before resuming (50s)');
    });
  });

  // Starvation DECORATES the ladder; it never preempts it. Before 2026-08-04 a
  // budget-caused starvation returned its own line from the top of the function,
  // which discarded the shortfall the runtime had already computed and swallowed
  // the copy of every hold power cannot lift.
  describe('starvation decoration', () => {
    it('keeps the shortfall and states how long the device has been held', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null, shortfallKw: 0.8 },
        starvation: starvation(2 * 60 * 60 * 1000),
      })).toBe(`Held 2${NBSP}h — 0.8 kW more needed`);
    });

    // The duration is the device's own fact; which ceiling binds is the hero's.
    // A budget-bound and a capacity-bound hold of the same age read identically.
    it('reads the same whichever ceiling is binding', () => {
      const forCode = (code: string): string => resolveHeldCardReasonLine({
        reason: { code, detail: null, shortfallKw: 1.1 },
        starvation: starvation(45 * 60 * 1000),
      });
      expect(forCode(PLAN_REASON_CODES.capacity)).toBe(`Held 45${NBSP}min — 1.1 kW more needed`);
      expect(forCode(PLAN_REASON_CODES.dailyBudget)).toBe(forCode(PLAN_REASON_CODES.capacity));
    });

    // The stepped card's `increase` verb has no bearing on the starved stem:
    // "Held 45 min" describes the hold, not the transition being denied.
    it('drops the verb distinction once starved', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.capacity, detail: null, shortfallKw: 0.3 },
        starvation: starvation(45 * 60 * 1000),
        verb: 'increase',
      })).toBe(`Held 45${NBSP}min — 0.3 kW more needed`);
    });

    it('decorates the spent-hour line, which still carries no kW', () => {
      const line = resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.hourlyBudget, detail: null },
        starvation: starvation(75 * 60 * 1000),
      });
      expect(line).toBe(`Held 1${NBSP}h${NBSP}15${NBSP}min — this hour's budget is spent`);
      expect(line).not.toContain('kW');
    });

    it('uses the plain held copy when no shortfall is available', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.capacity, detail: null },
        starvation: starvation(),
      })).toBe('Waiting for available power');
    });

    // The regression the preempting branch caused: a starved device merely
    // waiting out a restore cooldown had its countdown replaced by a ceiling
    // sentence. The countdown is what the device is actually waiting for.
    it('does not swallow the countdown copy of a starved device', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 50 },
        starvation: starvation(),
      })).toBe('Waiting before resuming (50s)');
    });

    // Same regression, other half: a hold power cannot lift keeps its own cause.
    // Freeing kW would not start these, so a kW figure would be a lie.
    it.each([
      [PLAN_REASON_CODES.deferredObjectiveAvoid],
      [PLAN_REASON_CODES.awaitingSolarSurplus],
      [PLAN_REASON_CODES.externalOffHold],
    ])('keeps the cause copy of a %s hold', (code) => {
      const starved = resolveHeldCardReasonLine({
        reason: { code, detail: null },
        starvation: starvation(),
      });
      // The exact copy is the reason formatter's business; what this pins is
      // that starvation changed NOTHING about it.
      expect(starved).toBe(resolveHeldCardReasonLine({ reason: { code, detail: null } }));
      expect(starved).not.toContain(`Held 20${NBSP}min`);
      expect(starved).not.toBe('Waiting for available power');
    });
  });

  // The settings UI reads reasons across a snapshot boundary, so a code this
  // build does not know must not reach `formatDeviceReasonUserFacing` — its
  // exhaustive-switch default returns the reason OBJECT at runtime, which
  // renders as a blank line.
  describe('snapshot-boundary robustness', () => {
    it.each([
      ['an unknown code', { code: 'status_ok', message: '' }],
      ['a missing code', {}],
      ['a non-object reason', 'capacity'],
      ['undefined', undefined],
    ])('always returns a user-facing string for %s', (_label, reason) => {
      const line = resolveHeldCardReasonLine({ reason });
      expect(typeof line).toBe('string');
      expect(line).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    });

    // `other` is a diagnostic carrier: `lib/plan/swap/candidates.ts` fills its
    // text from the LOG formatter, so passing it through would put planner
    // jargon ("insufficient headroom to restore …") on a card.
    it('never renders the diagnostic `other` reason text', () => {
      const line = resolveHeldCardReasonLine({
        reason: {
          code: PLAN_REASON_CODES.other,
          text: 'restore blocked: insufficient headroom (need 1.36kW, available 1.03kW) from Bathroom, Hallway',
        },
      });
      expect(line).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
      expect(line).not.toMatch(/headroom|restore blocked/i);
    });
  });

  describe('the stepped variant only changes the verb', () => {
    it('says "increase" for a running device denied a step up', () => {
      expect(resolveHeldCardReasonLine({
        reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null, shortfallKw: 0.3 },
        verb: 'increase',
      })).toBe('Waiting to increase — 0.3 kW more needed');
    });
  });
});

describe('formatShortfallLine', () => {
  it('renders one decimal', () => {
    expect(formatShortfallLine(1, 'resume')).toBe('Waiting to resume — 1.0 kW more needed');
  });
});

// Every line this ladder produces describes a hold PELS is performing — the
// device only waits, or sits at a capped step, because PELS put it there. In
// simulation PELS acts on nothing, so each must have a hypothetical form or a
// simulated card asserts a hold that never happened. The ladder's output used to
// be covered per-card; when it moved here the coverage did not follow, and the
// shortfall and stepped-fairness lines silently fell through the mood transform.
describe('every ladder output has a simulation form', () => {
  it.each([
    ['Waiting to resume — 0.8 kW more needed', 'Would be waiting to resume — 0.8 kW more needed (simulation)'],
    // The hourly-exhausted line is a PELS-performed hold like the shortfall
    // line, and shares its prefix, so it rides the same rewrite.
    ["Waiting to resume — this hour's budget is spent", "Would be waiting to resume — this hour's budget is spent (simulation)"],
    ["Waiting to increase — this hour's budget is spent", "Would be waiting to increase — this hour's budget is spent (simulation)"],
    ['Waiting to increase — 0.3 kW more needed', 'Would be waiting to increase — 0.3 kW more needed (simulation)'],
    [PLAN_STATE_HELD_FALLBACK_STATUS, 'Would be held back (simulation)'],
    // The starved forms. The elapsed duration cannot survive the transform: in
    // simulation PELS held nothing, so reporting "2 h" would assert a history
    // that never happened. Only the need clause carries over.
    [`Held 2${NBSP}h — 0.8 kW more needed`, 'Would be held back — 0.8 kW more needed (simulation)'],
    [`Held 1${NBSP}h${NBSP}15${NBSP}min — this hour's budget is spent`, "Would be held back — this hour's budget is spent (simulation)"],
    [
      'Holding at 6 A — cannot increase while 2 devices are limited',
      'Would be holding at 6 A — cannot increase while 2 devices are limited (simulation)',
    ],
    ['Holding — cannot increase while 3 devices are limited',
      'Would be holding — cannot increase while 3 devices are limited (simulation)'],
    // The startup-reservation line, reachable on a card again now that the
    // reservation hold names its holder instead of carrying a kW.
    ['Waiting so Water heater can start', 'Would be waiting so Water heater can start (simulation)'],
  ])('%s', (factual, hypothetical) => {
    expect(toSimulationReasonLine(factual, true)).toBe(hypothetical);
    expect(toSimulationReasonLine(factual, false)).toBe(factual);
  });

  // Not PELS-acted: the device was switched off outside PELS, so the line is a
  // fact about the world and stays factual under simulation.
  it('leaves the external-off recourse factual', () => {
    const external = 'Turned off elsewhere — turn it on to resume';
    expect(toSimulationReasonLine(external, true)).toBe(external);
  });
});

describe('isCeilingHoldReasonCode', () => {
  it('is false for undefined and for non-ceiling holds', () => {
    expect(isCeilingHoldReasonCode(undefined)).toBe(false);
    expect(isCeilingHoldReasonCode(PLAN_REASON_CODES.deferredObjectiveAvoid)).toBe(false);
    expect(isCeilingHoldReasonCode(PLAN_REASON_CODES.externalOffHold)).toBe(false);
  });
});
