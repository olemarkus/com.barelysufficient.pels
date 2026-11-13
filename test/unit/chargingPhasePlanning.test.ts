import { describe, expect, it } from 'vitest';
import {
  chargingPhaseDebit, chargingPhasePoint, chooseChargingPhaseOperation, ChargingPhasePlanningCycle,
  type ChargingPhaseAdmission,
} from '../../lib/plan/chargingPhasePlanning';
import type { ChargingPhaseCandidate, ChargingPhaseEnvelope } from '../../packages/planner-types/src/chargingPhases';
import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';
import { spendPhaseBudgetVector } from '../../lib/plan/phase/phaseRoom';
import { EMPTY_CHARGING_PHASE_READ } from '../../lib/ports/chargingPhases';
import { partialDouble } from '../helpers/partialDouble';
import { withChargingPhaseOffCandidates } from '../../lib/plan/restore/chargingPhaseRestore';
import { getRestoreCandidates } from '../../lib/plan/restore/devices';
import { ShedDecisions } from '../../lib/plan/shedDecisions';
import type { BinaryControlKind, DevicePlanDevice, MeteredKind, SteppedPlanDevice } from '../../lib/plan/planTypes';

const envelopes: readonly ChargingPhaseEnvelope[] = [1, 3].map((phases) => ({
  phases: phases as 1 | 3,
  footprint: phases === 1 ? { kind: 'single' as const, phase: 'L1' as const } : { kind: 'all_three' as const },
  profile: { steps: [
    { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    ...[6, 16].map((amps) => ({ id: `${amps}a`, planningPowerW: amps * phases * 230, planningCurrentA: amps })),
  ] },
}));

const candidate = (phases: 1 | 3, amps = 6, forceSinglePhase = false): ChargingPhaseCandidate => ({
  deviceId: 'charger', mode: 'automatic', minimumCurrentA: 6, envelopes, forceSinglePhase,
  observed: chargingPhasePoint(envelopes.find((entry) => entry.phases === phases)!, amps),
});
const unconstrained = (): ChargingPhaseAdmission => ({
  budgetExempt: false,
  axes: { capacity: { kind: 'off' }, grid: { kind: 'off' }, budget: { kind: 'off' }, phase: { kind: 'off' } },
});

describe('phase alternative admission', () => {
  it('uses one phase for a 2 kW solar allocation without crediting outgoing power', () => {
    const chosen = chooseChargingPhaseOperation(candidate(3), { ...unconstrained(), solarKw: 2 });
    expect(chosen?.decision.target).toMatchObject({ phases: 1, currentA: 6, totalKw: 1.38 });
    expect(chosen?.decision.reservation.totalKw).toBeCloseTo(4.14);
    expect(chosen?.debit.totalKw).toBe(0);
    expect(chosen?.debit.perPhaseKw).toEqual({ L1: 0, L2: 0, L3: 0 });
  });

  it('does not start an unverified single-phase mode when possible 3p minimum cannot fit', () => {
    const read = candidate(3, 0);
    const admission = unconstrained();
    admission.axes.grid = { kind: 'on', kw: 2 };
    expect(chooseChargingPhaseOperation(read, { ...admission, solarKw: 2 })).toBeUndefined();
    admission.axes.grid = { kind: 'on', kw: 5 };
    const chosen = chooseChargingPhaseOperation(read, { ...admission, solarKw: 2 });
    expect(chosen?.debit.totalKw).toBeCloseTo(4.14);
  });

  it('does not expand permission for a single-phase car already permitted three phases', () => {
    expect(chooseChargingPhaseOperation(candidate(1), unconstrained())).toBeUndefined();
  });

  it('keeps an existing single-phase permission while idle physical geometry remains conservatively three-phase', () => {
    const read = { ...candidate(3, 0, true), mode: 'single' as const };
    expect(chooseChargingPhaseOperation(read, unconstrained())).toBeUndefined();
  });

  it('can restrict permission even when an unrestricted car already draws on one phase', () => {
    const read = { ...candidate(1), mode: 'single' as const };
    expect(chooseChargingPhaseOperation(read, unconstrained())?.decision.target.phases).toBe(1);
  });

  it('checks the new footprint before choosing three phases', () => {
    const admission = unconstrained();
    admission.axes.phase = { kind: 'on', roomKw: { L1: 8, L2: 0.1, L3: 8 } };
    expect(chooseChargingPhaseOperation(candidate(1, 6, true), admission)).toBeUndefined();
    admission.axes.phase = { kind: 'on', roomKw: { L1: 8, L2: 5, L3: 5 } };
    expect(chooseChargingPhaseOperation(candidate(1, 6, true), admission)?.decision.target.phases).toBe(3);
  });

  it('retains one phase when it meets the actual booked task power', () => {
    const admission = { ...unconstrained(), requirement: { admissionKw: 3, permittedMaxKw: 11.04 } };
    expect(chooseChargingPhaseOperation(candidate(1, 6, true), admission)).toBeUndefined();
    admission.requirement.admissionKw = 8;
    expect(chooseChargingPhaseOperation(candidate(1, 6, true), admission)?.decision.target.phases).toBe(3);
  });

  it('can add the two other phases while the current single phase has no spare room', () => {
    const admission = unconstrained();
    admission.axes.phase = { kind: 'on', roomKw: { L1: 0, L2: 2, L3: 2 } };
    const chosen = chooseChargingPhaseOperation(candidate(1, 6, true), admission);
    expect(chosen?.decision.target).toMatchObject({ phases: 3, currentA: 6 });
    expect(chosen?.debit.perPhaseKw.L1).toBe(0);
    expect(chosen?.debit.perPhaseKw.L2).toBeCloseTo(1.38);
    expect(chosen?.debit.totalKw).toBeCloseTo(2.76);
  });

  it('prepares at the current maximum before requesting a physical phase change', () => {
    const chosen = chooseChargingPhaseOperation(candidate(1, 16, true), unconstrained());
    expect(chosen?.decision).toMatchObject({ kind: 'prepare', target: { phases: 3, currentA: 6 } });
    expect(chosen?.decision.reservation.perPhaseKw).toEqual({ L1: 3.68, L2: 1.38, L3: 1.38 });
    expect(chosen?.decision.reservation.totalKw).toBeCloseTo(4.14);
    expect(chooseChargingPhaseOperation(candidate(1, 6, true), unconstrained())?.decision.kind).toBe('switch');
  });

  it('does not lower current for a target whose new phases cannot admit its floor and margin now', () => {
    const admission = unconstrained();
    admission.axes.phase = { kind: 'on', roomKw: { L1: 10, L2: 1.4, L3: 10 } };
    expect(chooseChargingPhaseOperation(candidate(1, 16, true), admission)).toBeUndefined();
  });
});

describe('phase reservation ledgers', () => {
  it('transfers an admitted preparation reservation into switching without a second debit', () => {
    const prepared = candidate(1, 6, true);
    const reservation = { deviceId: 'charger', totalKw: 4.14, perPhaseKw: { L1: 3.68, L2: 1.38, L3: 1.38 } };
    const cycle = new ChargingPhasePlanningCycle({
      ...EMPTY_CHARGING_PHASE_READ, candidates: [prepared], reservations: [reservation],
      observations: [{ deviceId: 'charger', ...prepared.observed }],
    });
    const alreadySpent = {
      capacity: { kind: 'on' as const, kw: 0 }, grid: { kind: 'on' as const, kw: 0 },
      budget: { kind: 'on' as const, kw: 0 },
      phase: { kind: 'on' as const, roomKw: { L1: 0, L2: 0, L3: 0 } },
    };
    // 5 kW solar less this operation's 2.76 kW incoming reservation and the solar clear band.
    expect(cycle.chooseSurplus('charger', 5 - 2.76 - 0.25, alreadySpent.phase)?.decision.target.phases).toBe(3);
    cycle.offerRestoreBudget('charger', alreadySpent);
    expect(cycle.chooseRestore('charger', false)?.decision.kind).toBe('switch');
    expect(cycle.selectedDebit('charger')).toEqual({ totalKw: 0, perPhaseKw: { L1: 0, L2: 0, L3: 0 } });
  });

  it('keeps a firmware idle transition through a timer hold but withdraws it for a real safety hold', () => {
    const target = chargingPhasePoint(envelopes[1], 6);
    const continuation = { kind: 'switch' as const, deviceId: 'charger', target, reservation: { deviceId: 'charger', ...target } };
    const cycle = new ChargingPhasePlanningCycle({ ...EMPTY_CHARGING_PHASE_READ, continuations: [continuation] });
    const device = partialDouble<DevicePlanDevice>({
      id: 'charger', available: true, control: { managed: true, commandAuthority: true },
      plannedState: 'shed',
    });
    expect(cycle.finish([device], new Set())).toEqual([continuation]);
    expect(cycle.finish([device], new Set(['charger']))).toEqual([]);
  });

  it('releases the solar floor restriction after the retained claim reservation settles to zero', () => {
    const cycle = new ChargingPhasePlanningCycle({
      ...EMPTY_CHARGING_PHASE_READ,
      reservations: [{ deviceId: 'charger', totalKw: 0, perPhaseKw: { L1: 0, L2: 0, L3: 0 } }],
    });
    expect(cycle.hasReservation('charger')).toBe(false);
  });

  it('reconsiders an admitted off phase start at its next ranked turn while qualification is pending', () => {
    const device = partialDouble<SteppedPlanDevice & MeteredKind & BinaryControlKind>({
      id: 'charger', currentOn: false, currentDrawKw: 0, plannedState: 'keep',
      control: { managed: true, commandAuthority: true },
      steppedLoadProfile: envelopes[1].profile, selectedStepId: 'off',
    });
    const history = new ShedDecisions();
    history.hasRecordedPlan = true;
    history.lastPlannedDeviceIds = new Set(['charger']);
    history.lastPlannedKeptIds = new Set(['charger']);
    const ordinary = getRestoreCandidates([device], history);
    expect(ordinary).toEqual([]);
    const phases = new ChargingPhasePlanningCycle({ ...EMPTY_CHARGING_PHASE_READ, candidates: [candidate(3, 0)] });
    expect(withChargingPhaseOffCandidates([device], ordinary, phases).map((entry) => entry.device.id))
      .toEqual(['charger']);
    expect(withChargingPhaseOffCandidates([device], ordinary,
      new ChargingPhasePlanningCycle(EMPTY_CHARGING_PHASE_READ))).toEqual([]);
    const held = { ...device, externalOffHoldActive: true as const };
    expect(withChargingPhaseOffCandidates([held], ordinary, phases)).toEqual([]);
  });

  it('debits the incoming phase at equal aggregate power without freeing the outgoing phase', () => {
    const debit = chargingPhaseDebit({ totalKw: 3, perPhaseKw: { L1: 1, L2: 1, L3: 1 } }, {
      totalKw: 3, perPhaseKw: { L1: 3, L2: 0, L3: 0 },
    });
    expect(debit).toEqual({ totalKw: 0, perPhaseKw: { L1: 0, L2: 1, L3: 1 } });
    const ledger = buildRestoreHeadroomLedger({
      capacity: { kind: 'on', kw: 4 }, grid: { kind: 'on', kw: 4 }, budget: { kind: 'on', kw: 4 },
      phase: { kind: 'on', roomKw: { L1: 2, L2: 2, L3: 2 } },
    });
    ledger.commitPhaseVector({ budgetExempt: false }, debit);
    expect(ledger.axes()).toEqual({
      capacity: { kind: 'on', kw: 4 }, grid: { kind: 'on', kw: 4 }, budget: { kind: 'on', kw: 4 },
      phase: { kind: 'on', roomKw: { L1: 2, L2: 1, L3: 1 } },
    });
    const solar = spendPhaseBudgetVector({
      room: { kind: 'on', roomKw: { L1: 2, L2: 2, L3: 2 } },
      exportRemainder: new Map([['L1', 2], ['L2', 2]]),
    }, debit.perPhaseKw);
    expect(solar.room).toEqual(ledger.axes().phase);
    expect([...solar.exportRemainder]).toEqual([['L1', 2], ['L2', 1]]);
  });

  it('retains the whole pending load when the firmware temporarily draws zero', () => {
    expect(chargingPhaseDebit({ totalKw: 4.14, perPhaseKw: { L1: 1.38, L2: 1.38, L3: 1.38 } }, {
      totalKw: 0, perPhaseKw: { L1: 0, L2: 0, L3: 0 },
    })).toEqual({ totalKw: 4.14, perPhaseKw: { L1: 1.38, L2: 1.38, L3: 1.38 } });
  });
});
