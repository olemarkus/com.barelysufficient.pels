import { createPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';
import {
  SURPLUS_ABSORB_MIN_DWELL_MS,
  SURPLUS_ABSORB_RESERVE_KW,
  SURPLUS_ABSORB_SETTLE_MS,
  syncSurplusEligibilityState,
} from '../../lib/plan/admission/surplusAbsorb';
import { captureLogger } from '../utils/loggerCapture';

const DEVICE = 'heater-1';
const EXPECTED_DRAW_KW = 1;
const AMPLE_SURPLUS_KW = 2; // clears the engage bar of expectedDraw + reserve

const baseParams = (overrides: Record<string, unknown> = {}) => ({
  deviceId: DEVICE,
  willing: true,
  expectedDrawKw: EXPECTED_DRAW_KW,
  availableSurplusKw: AMPLE_SURPLUS_KW,
  hardOff: false,
  ...overrides,
});

// Settle requires the condition to persist across cycles, so engagement needs a
// priming call to open the window then a confirming call a settle-window later.
const engageAt = (state: PlanEngineState, engagedMs: number, overrides: Record<string, unknown> = {}) => {
  syncSurplusEligibilityState({ state, ...baseParams(overrides), nowTs: engagedMs - SURPLUS_ABSORB_SETTLE_MS });
  return syncSurplusEligibilityState({ state, ...baseParams(overrides), nowTs: engagedMs });
};

describe('surplus-absorb eligibility gate', () => {
  it('never engages a non-willing device and clears any leftover state', () => {
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice[DEVICE] = { eligible: true, sinceMs: 0 };
    const result = syncSurplusEligibilityState({ state, ...baseParams({ willing: false }), nowTs: 1000 });
    expect(result.eligible).toBe(false);
    expect(state.surplusEligibilityByDevice[DEVICE]).toBeUndefined();
  });

  it('never engages without an expected-draw estimate', () => {
    const state = createPlanEngineState(0);
    expect(engageAt(state, SURPLUS_ABSORB_SETTLE_MS, { expectedDrawKw: 0 }).eligible).toBe(false);
  });

  it('engages only after the surplus persists for the settle window', () => {
    const state = createPlanEngineState(0);
    expect(syncSurplusEligibilityState({ state, ...baseParams(), nowTs: 0 }).eligible).toBe(false);
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: SURPLUS_ABSORB_SETTLE_MS - 1 }).eligible,
    ).toBe(false);
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: SURPLUS_ABSORB_SETTLE_MS }).eligible,
    ).toBe(true);
  });

  it('applies the overshoot-fit gate: surplus must cover expected draw plus the reserve', () => {
    const justUnder = createPlanEngineState(0);
    const under = EXPECTED_DRAW_KW + SURPLUS_ABSORB_RESERVE_KW - 0.01;
    expect(engageAt(justUnder, SURPLUS_ABSORB_SETTLE_MS, { availableSurplusKw: under }).eligible).toBe(false);

    const justOver = createPlanEngineState(0);
    const over = EXPECTED_DRAW_KW + SURPLUS_ABSORB_RESERVE_KW;
    expect(engageAt(justOver, SURPLUS_ABSORB_SETTLE_MS, { availableSurplusKw: over }).eligible).toBe(true);
  });

  it('releases after the min-dwell once the allocated surplus is gone', () => {
    const state = createPlanEngineState(0);
    const engagedAt = SURPLUS_ABSORB_SETTLE_MS;
    engageAt(state, engagedAt);
    const gone = { availableSurplusKw: 0 };

    // Min dwell holds the lift first, even with the release condition sustained.
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(gone), nowTs: engagedAt + SURPLUS_ABSORB_MIN_DWELL_MS - 1 })
        .eligible,
    ).toBe(true);
    // Past the dwell, once the release settles, it drops back and the entry clears.
    expect(
      syncSurplusEligibilityState({
        state,
        ...baseParams(gone),
        nowTs: engagedAt + SURPLUS_ABSORB_MIN_DWELL_MS + SURPLUS_ABSORB_SETTLE_MS,
      }).eligible,
    ).toBe(false);
    expect(state.surplusEligibilityByDevice[DEVICE]).toBeUndefined();
  });

  it('never engages when the allocated surplus is unknown (null)', () => {
    const state = createPlanEngineState(0);
    expect(engageAt(state, SURPLUS_ABSORB_SETTLE_MS, { availableSurplusKw: null }).eligible).toBe(false);
  });
});

describe('surplus-absorb hard-off early release', () => {
  const ENGAGED_AT = SURPLUS_ABSORB_SETTLE_MS;
  // Sustained-import shape: the allocated surplus is gone AND the caller flags
  // the condition as unambiguous (import beyond the hard-off bar).
  const sustainedImport = { availableSurplusKw: 0, hardOff: true };
  // Power-signal-lost shape: surplus unknown (null) is also a hard-off.
  const powerLost = { availableSurplusKw: null, hardOff: true };

  it('releases one settle window into a sustained hard-off, without waiting out the min dwell', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    const hardOffStart = ENGAGED_AT + 1000;
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: hardOffStart }).eligible,
    ).toBe(true);
    const releaseAt = hardOffStart + SURPLUS_ABSORB_SETTLE_MS;
    // The whole point: the release lands well inside the min dwell.
    expect(releaseAt - ENGAGED_AT).toBeLessThan(SURPLUS_ABSORB_MIN_DWELL_MS);
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: releaseAt }).eligible,
    ).toBe(false);
    // A hard_off release RETAINS the settled-off entry (unlike a dwell release):
    // its sinceMs carries the owed off-state dwell. The sustain clock is cleared.
    expect(state.surplusEligibilityByDevice[DEVICE]).toMatchObject({
      eligible: false,
      sinceMs: releaseAt,
      hardOffReleased: true,
    });
    expect(state.surplusEligibilityByDevice[DEVICE]?.hardOffSinceMs).toBeUndefined();
  });

  it('still applies the settle confirmation on the hard-off path', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    const hardOffStart = ENGAGED_AT + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: hardOffStart });
    expect(
      syncSurplusEligibilityState({
        state,
        ...baseParams(sustainedImport),
        nowTs: hardOffStart + SURPLUS_ABSORB_SETTLE_MS - 1,
      }).eligible,
    ).toBe(true);
  });

  it('releases early when the power signal is lost (surplus null + hardOff)', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    const lostAt = ENGAGED_AT + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(powerLost), nowTs: lostAt });
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(powerLost), nowTs: lostAt + SURPLUS_ABSORB_SETTLE_MS })
        .eligible,
    ).toBe(false);
  });

  it('resets the hard-off clock when the condition clears, so an import blip cannot bypass the dwell', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    const blipAt = ENGAGED_AT + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: blipAt });
    // Blip ends: surplus still gone (an ordinary dip), but hardOff is false → clock resets.
    syncSurplusEligibilityState({
      state, ...baseParams({ availableSurplusKw: 0, hardOff: false }), nowTs: blipAt + 1000,
    });
    expect(state.surplusEligibilityByDevice[DEVICE]?.hardOffSinceMs).toBeUndefined();
    // A settle window after the blip started — where a sustained hard-off would
    // have released — the dwell still holds the lift.
    expect(
      syncSurplusEligibilityState({
        state, ...baseParams({ availableSurplusKw: 0, hardOff: false }), nowTs: blipAt + SURPLUS_ABSORB_SETTLE_MS,
      }).eligible,
    ).toBe(true);
  });

  it('genuine dip (hardOff false) still honours the min dwell before releasing', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    const dip = { availableSurplusKw: 0, hardOff: false };
    const dipStart = ENGAGED_AT + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(dip), nowTs: dipStart });
    // Discriminating region: the release settle HAS elapsed but the dwell has
    // not — a hard-off would already have released here; the dip must hold.
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(dip), nowTs: dipStart + SURPLUS_ABSORB_SETTLE_MS })
        .eligible,
    ).toBe(true);
    // Past the dwell (with the release condition long settled) it drops back.
    expect(
      syncSurplusEligibilityState({
        state,
        ...baseParams(dip),
        nowTs: ENGAGED_AT + SURPLUS_ABSORB_MIN_DWELL_MS + SURPLUS_ABSORB_SETTLE_MS,
      }).eligible,
    ).toBe(false);
  });

  it('re-engage after a hard_off release owes the full off-state dwell (limit-cycle bound)', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    const hardOffStart = ENGAGED_AT + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: hardOffStart });
    const releasedAt = hardOffStart + SURPLUS_ABSORB_SETTLE_MS;
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: releasedAt }).eligible,
    ).toBe(false);

    // Surplus returns immediately (the measured-feedback shape: the device's own
    // draw manufactured the import, so turning it off restores the export).
    const surplusBackAt = releasedAt + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(), nowTs: surplusBackAt });
    // One settle window later the engage condition has settled, but the owed
    // off-state dwell must still block it — without the retained entry this
    // would re-engage here (the ~200 s limit cycle).
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: surplusBackAt + SURPLUS_ABSORB_SETTLE_MS })
        .eligible,
    ).toBe(false);
    // Once the full dwell since the hard_off release has passed, it may engage.
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: releasedAt + SURPLUS_ABSORB_MIN_DWELL_MS })
        .eligible,
    ).toBe(true);
  });

  it('re-engage after a dwell_elapsed release owes only the settle window (entry dropped)', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    const dip = { availableSurplusKw: 0, hardOff: false };
    syncSurplusEligibilityState({ state, ...baseParams(dip), nowTs: ENGAGED_AT + SURPLUS_ABSORB_MIN_DWELL_MS });
    const releasedAt = ENGAGED_AT + SURPLUS_ABSORB_MIN_DWELL_MS + SURPLUS_ABSORB_SETTLE_MS;
    expect(syncSurplusEligibilityState({ state, ...baseParams(dip), nowTs: releasedAt }).eligible).toBe(false);
    // The passing-cloud release drops the entry — no dwell floor survives it.
    expect(state.surplusEligibilityByDevice[DEVICE]).toBeUndefined();

    // Cloud passes: export is back — the fast re-engage after a bare settle window.
    const surplusBackAt = releasedAt + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(), nowTs: surplusBackAt });
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: surplusBackAt + SURPLUS_ABSORB_SETTLE_MS })
        .eligible,
    ).toBe(true);
  });

  it('classifies as hard_off even when the dwell has already elapsed (long-running lift), retaining the entry', () => {
    const state = createPlanEngineState(0);
    engageAt(state, ENGAGED_AT);
    // The lift has been engaged LONGER than the min dwell before the sustained
    // import starts, so at release time dwellOk AND the hard-off bypass both
    // hold — hard_off must take precedence, or the entry is dropped and the
    // measured-feedback limit cycle returns for long-running lifts.
    const importStart = ENGAGED_AT + SURPLUS_ABSORB_MIN_DWELL_MS + 10_000;
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: importStart }).eligible,
    ).toBe(true);
    const releasedAt = importStart + SURPLUS_ABSORB_SETTLE_MS;
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(sustainedImport), nowTs: releasedAt }).eligible,
    ).toBe(false);
    expect(state.surplusEligibilityByDevice[DEVICE]).toMatchObject({
      eligible: false,
      sinceMs: releasedAt,
      hardOffReleased: true,
    });

    // Turning the device off restored the export — the re-engage still owes
    // the full off-state dwell.
    const surplusBackAt = releasedAt + 1000;
    syncSurplusEligibilityState({ state, ...baseParams(), nowTs: surplusBackAt });
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: surplusBackAt + SURPLUS_ABSORB_SETTLE_MS })
        .eligible,
    ).toBe(false);
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: releasedAt + SURPLUS_ABSORB_MIN_DWELL_MS })
        .eligible,
    ).toBe(true);
  });

  it('never dwell-skips an engage, even with hardOff set', () => {
    const state = createPlanEngineState(0);
    // Freshly flipped off at t0 — the flip stamped sinceMs, so engage owes the dwell.
    state.surplusEligibilityByDevice[DEVICE] = { eligible: false, sinceMs: 0 };
    syncSurplusEligibilityState({ state, ...baseParams({ hardOff: true }), nowTs: 0 });
    expect(
      syncSurplusEligibilityState({ state, ...baseParams({ hardOff: true }), nowTs: SURPLUS_ABSORB_SETTLE_MS })
        .eligible,
    ).toBe(false);
    // Once the dwell has passed, the ordinary engage proceeds.
    expect(
      syncSurplusEligibilityState({ state, ...baseParams({ hardOff: true }), nowTs: SURPLUS_ABSORB_MIN_DWELL_MS })
        .eligible,
    ).toBe(true);
  });

  it('structured release log distinguishes a hard-off release from a dwell release', () => {
    const capture = captureLogger();
    try {
      const hardState = createPlanEngineState(0);
      engageAt(hardState, ENGAGED_AT);
      const hardOffStart = ENGAGED_AT + 1000;
      syncSurplusEligibilityState({ state: hardState, ...baseParams(sustainedImport), nowTs: hardOffStart });
      syncSurplusEligibilityState({
        state: hardState, ...baseParams(sustainedImport), nowTs: hardOffStart + SURPLUS_ABSORB_SETTLE_MS,
      });

      const dwellState = createPlanEngineState(0);
      engageAt(dwellState, ENGAGED_AT);
      const dip = { availableSurplusKw: 0, hardOff: false };
      syncSurplusEligibilityState({ state: dwellState, ...baseParams(dip), nowTs: ENGAGED_AT + SURPLUS_ABSORB_MIN_DWELL_MS });
      syncSurplusEligibilityState({
        state: dwellState,
        ...baseParams(dip),
        nowTs: ENGAGED_AT + SURPLUS_ABSORB_MIN_DWELL_MS + SURPLUS_ABSORB_SETTLE_MS,
      });

      const releases = capture.findEvents('surplus_absorb_released');
      expect(releases.map((entry) => entry.releaseCause)).toEqual(['hard_off', 'dwell_elapsed']);
      expect(releases[0]).toMatchObject({ deviceId: DEVICE });
      expect(typeof releases[0]?.heldMs).toBe('number');
    } finally {
      capture.restore();
    }
  });
});
