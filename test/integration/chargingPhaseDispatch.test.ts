import { describe, expect, it, vi } from 'vitest';
import { ChargingPhaseControlOwner } from '../../lib/chargingPhases/chargingPhaseControlOwner';
import { CHARGING_PHASE_RECORD_PREFIX } from '../../lib/chargingPhases/phaseClaimStore';
import { ChargingPhaseExecutor } from '../../lib/executor/chargingPhaseExecutor';
import { withChargingPhaseControl } from '../../lib/executor/chargingPhaseDispatch';
import { ChargingPhasePlanningCycle } from '../../lib/plan/chargingPhasePlanning';
import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';
import type { ChargingPhaseActuation, ChargingPhaseDevice, ChargingPhaseSource } from '../../lib/ports/chargingPhases';
import type { ControlContestRecording } from '../../lib/ports/controlContest';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { PlannedCommandAxes, PlannedDeviceCommands } from '../../lib/planContract/executionPlan';
import type { ChargingPhaseEnvelope } from '../../packages/planner-types/src/chargingPhases';
import { CHARGING_PHASE_SETTINGS_KEY } from '../../packages/shared-domain/src/settings/chargingPhases';
import { partialDouble } from '../helpers/partialDouble';
import type { ExecutableObservedDeviceState } from '../../lib/executor/executablePlan';

const NOW = Date.UTC(2026, 10, 13, 10);
const ID = 'charger';
const RECORD_KEY = `${CHARGING_PHASE_RECORD_PREFIX}${ID}`;
const envelopes: readonly ChargingPhaseEnvelope[] = ([1, 3] as const).map((phases) => ({
  phases, footprint: phases === 1 ? { kind: 'single', phase: 'L1' } : { kind: 'all_three' },
  profile: { steps: [{ id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    { id: '6a', planningCurrentA: 6, planningPowerW: phases * 1380 },
    { id: '16a', planningCurrentA: 16, planningPowerW: phases * 3680 }] },
}));

function fixture() {
  const values = new Map<string, unknown>([[CHARGING_PHASE_SETTINGS_KEY,
    { [ID]: { mode: 'three', installationConfirmed: true } }]]);
  const settings: SettingsPort = {
    get: (key) => values.get(key), set: (key, value) => { values.set(key, value); },
    unset: (key) => { values.delete(key); }, getKeys: () => [...values.keys()],
  };
  let device: ChargingPhaseDevice = {
    deviceId: ID, available: true, connected: true, managed: true, controlEnabled: true,
    forceSinglePhase: true, forceSinglePhaseObservedAtMs: NOW,
    currentLimitA: 16, minimumCurrentA: 6, maximumCurrentA: 16, configuredPhases: 3, planningPhases: 1, drawingPhases: 1,
    powers: [{ watts: 3680, observedAtMs: NOW }, { watts: 0, observedAtMs: NOW }, { watts: 0, observedAtMs: NOW }],
    totalPower: { watts: 3680, observedAtMs: NOW },
  };
  const source: ChargingPhaseSource = {
    readDevices: () => [device], envelopes: () => envelopes, isSimulation: () => false,
    releasePlanningEnvelope: vi.fn(),
    observedPoint: (read, phases) => ({
      phases, currentA: read.currentLimitA, totalKw: read.totalPower.watts / 1000,
      perPhaseKw: { L1: read.powers[0].watts / 1000, L2: read.powers[1].watts / 1000, L3: read.powers[2].watts / 1000 },
    }),
  };
  const apply = vi.fn<ChargingPhaseActuation['apply']>(async (command) => {
    // This runs at the actuator boundary, after the owner must have persisted the claim.
    expect(values.get(RECORD_KEY)).toMatchObject({ kind: 'held', originalForceSingle: true,
      reservation: { totalKw: 4.14, perPhaseKw: { L1: 3.68, L2: 1.38, L3: 1.38 } } });
    expect(command.kind).toBe('charging_phase_prepare');
    device = { ...device, currentLimitA: 6 }; // Optimistic limit echo; power has not fallen yet.
    return { requested: true };
  });
  const contest: ControlContestRecording = {
    commandSent: vi.fn(), controlReported: vi.fn(), commandReleased: vi.fn(), retainPlanned: vi.fn(),
  };
  const owner = new ChargingPhaseControlOwner(settings, source, { apply }, contest, {
    forDevice: () => ({ onStarting: vi.fn(), onAccepted: vi.fn(), onFailed: vi.fn() }),
  });
  return { owner, values, apply };
}

function solarLoweringIntent(): PlannedDeviceCommands & PlannedCommandAxes {
  return { id: ID, name: 'Charger', commandAuthority: true, projection: 'decided', steppedLoad: {
    id: ID, name: 'Charger', steppedLoadProfile: envelopes[0].profile, desired: { stepId: '6a' }, stepDirection: 'any',
    transition: { effectiveTransition: 'step_down_while_on', stepPreparationPurpose: null,
      binaryTarget: null, transitionPhase: 'settled' },
  } };
}

describe('phase planning and ordinary dispatch', () => {
  it('keeps PREPARE responsible for the matching solar reduction and reserves its target before lowering', async () => {
    const f = fixture();
    const read = f.owner.readPlanning(NOW);
    const cycle = new ChargingPhasePlanningCycle(read);
    const axes = { capacity: { kind: 'off' as const }, grid: { kind: 'off' as const }, budget: { kind: 'off' as const },
      phase: { kind: 'on' as const, roomKw: { L1: 10, L2: 10, L3: 10 } } };
    expect(cycle.chooseSurplus(ID, 8, axes.phase)?.decision.kind).toBe('prepare');
    cycle.offerRestoreBudget(ID, axes);
    const preparation = cycle.chooseRestore(ID, false)?.decision;
    if (preparation?.kind !== 'prepare') throw new Error('Expected an admitted preparation.');
    const executor = new ChargingPhaseExecutor(f.owner);
    const ordinary = vi.fn(async () => 'ordinary');
    const observed = partialDouble<ExecutableObservedDeviceState>({
      id: ID, observedEffectiveOn: true, steppedLoad: { on: true, reportedStepId: '16a', currentDrawKw: 3.68 },
    });
    // Match PlanExecutor's concurrent phase and ordinary lanes, including the queued owner dispatch.
    const phaseWork = executor.apply([preparation], NOW + 1);
    const ordinaryWork = withChargingPhaseControl(executor, solarLoweringIntent(), observed, preparation, ordinary, 'skipped');
    await Promise.all([phaseWork, ordinaryWork]);
    expect(ordinary).not.toHaveBeenCalled();
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.owner.blocksIncrease(ID)).toBe(true);

    const next = new ChargingPhasePlanningCycle(f.owner.readPlanning(NOW + 10_000));
    const pending = next.pendingDebits().get(ID);
    expect(pending?.totalKw).toBeCloseTo(0.46);
    expect(pending?.perPhaseKw).toEqual({ L1: 0, L2: 1.38, L3: 1.38 });
    const ledger = buildRestoreHeadroomLedger({ ...axes,
      phase: { kind: 'on', roomKw: { L1: 10, L2: 1.5, L3: 1.5 } } });
    if (!pending) throw new Error('Expected the admitted incoming reservation.');
    ledger.commitPhaseVector({ budgetExempt: false }, pending);
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'single', phase: 'L2' } })).toBeCloseTo(0.12);
  });
});
