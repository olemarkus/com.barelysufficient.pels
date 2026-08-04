import { resolveSteppedEvExceptionLabel } from '../../shared-domain/src/planSteppedCardText.ts';

/**
 * The card must not assert a cause it cannot observe. Matrix of record:
 * `notes/ev-charger-state-copy.md`.
 *
 * `currentState` is signal 2 — the `evcharger_charging` read-back. `on` means
 * the charger has been told to deliver current (by PELS or anyone else), which
 * is the precondition for anything being able to wait on the car.
 */

type EvCard = Parameters<typeof resolveSteppedEvExceptionLabel>[0];

const card = (overrides: Partial<EvCard> = {}): EvCard => ({
  controlCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in',
  currentState: 'on',
  ...overrides,
});

describe('EV card label with an associated car', () => {
  it('names the car as the holdout when the charger is on and no car is associated', () => {
    // The charger was told to charge and no current flows. With no car to ask,
    // that is still the strongest available statement; the association upgrades
    // the GRADE of the claim from inference to observation.
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

  it('blames nobody while the charger is switched off', () => {
    // Prod 2026-08-04, `Elbillader`: Power-limit control off, charger commanded
    // off, both charger and car plugged in and idle. The card read "Waiting for
    // car" off PELS's keep-path target step — a command PELS never sent. Nothing
    // waits on a car that has been offered no current.
    expect(resolveSteppedEvExceptionLabel(card({
      currentState: 'off', carChargingState: 'plugged_in',
    }))).toBe('Not charging');
  });

  it('does not call a switched-off charger a contradiction when the car lags behind', () => {
    // A car still reporting `plugged_in_charging` right after an off command is
    // the expected lag, not a fault — reporting it would print the contradiction
    // on every shed until the car app catches up.
    expect(resolveSteppedEvExceptionLabel(card({
      currentState: 'off', carChargingState: 'plugged_in_charging',
    }))).toBe('Not charging');
  });
});
