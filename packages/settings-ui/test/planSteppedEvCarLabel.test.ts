import { resolveSteppedEvExceptionLabel } from '../../shared-domain/src/planSteppedCardText.ts';
import type { SteppedLoadProfile } from '../../contracts/src/types.ts';

/**
 * The card must not assert a cause it cannot observe. Matrix of record:
 * `notes/ev-charger-state-copy.md`.
 */

const PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [{ id: 'off', planningPowerW: 0 }, { id: '6a', planningPowerW: 1380 }],
};

type EvCard = Parameters<typeof resolveSteppedEvExceptionLabel>[0];

const card = (overrides: Partial<EvCard> = {}): EvCard => ({
  controlCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in',
  steppedLoad: { targetStepId: '6a', reportedStepId: null, commandPending: false, profile: PROFILE },
  ...overrides,
});

describe('EV card label with an associated car', () => {
  it('keeps the intent-based inference when no car is associated', () => {
    // Retained from #1973 rather than dropped: with no car to ask, PELS's own
    // commanded step is the best evidence there is. The association upgrades the
    // GRADE of this claim from inference to observation, it does not introduce it.
    expect(resolveSteppedEvExceptionLabel(card())).toBe('Waiting for car');
  });

  it('names the car as the holdout when the car itself says it is not charging', () => {
    expect(resolveSteppedEvExceptionLabel(card({ carChargingState: 'plugged_in' })))
      .toBe('Waiting for car');
    expect(resolveSteppedEvExceptionLabel(card({ carChargingState: 'plugged_in_paused' })))
      .toBe('Waiting for car');
  });

  it('reports a contradiction rather than picking a side', () => {
    // Both observe the same plug: the charger sees no current, the car believes
    // it is charging. A lagging car app or a wrong association — either way it
    // is a fault, and smoothing it over hides it.
    expect(resolveSteppedEvExceptionLabel(card({ carChargingState: 'plugged_in_charging' })))
      .toBe('Car and charger disagree');
  });

  it('falls back to the plain fact when the car says it is not plugged in', () => {
    // The association is suspect; claiming the car is the holdout would compound
    // one wrong inference with another.
    expect(resolveSteppedEvExceptionLabel(card({ carChargingState: 'plugged_out' })))
      .toBe('Not charging');
  });

  it('reports a contradiction when the charger halted but the car says charging', () => {
    expect(resolveSteppedEvExceptionLabel(card({
      evChargingState: 'plugged_in_paused', carChargingState: 'plugged_in_charging',
    }))).toBe('Car and charger disagree');
  });

  it('attributes a pause to the car when both agree on it', () => {
    expect(resolveSteppedEvExceptionLabel(card({
      evChargingState: 'plugged_in_paused', carChargingState: 'plugged_in_paused',
    }))).toBe('Paused by the car');
  });

  it('leaves a charger-side pause alone when the car is merely idle', () => {
    expect(resolveSteppedEvExceptionLabel(card({
      evChargingState: 'plugged_in_paused', carChargingState: 'plugged_in',
    }))).toBe('Paused');
  });

  it('blames nobody while PELS is not asking for current', () => {
    // The regression #1973 fixed, now with a car present: PELS left the charger
    // idle, so the car is not the holdout no matter what it reports.
    expect(resolveSteppedEvExceptionLabel(card({
      steppedLoad: { targetStepId: 'off', reportedStepId: null, commandPending: false, profile: PROFILE },
      carChargingState: 'plugged_in',
    }))).toBe('Not charging');
  });

  it('says nothing new in simulation', () => {
    // The powered target is hypothetical — PELS never sent the command — so the
    // car cannot be the holdout of anything.
    expect(resolveSteppedEvExceptionLabel(card({ carChargingState: 'plugged_in' }), true))
      .toBe('Not charging');
  });
});
