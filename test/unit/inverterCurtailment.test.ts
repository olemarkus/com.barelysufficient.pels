import { describe, expect, it } from 'vitest';
import { retainSolarWhileDemandSettles } from '../../lib/plan/planBuilderSurplus';
import { InverterCurtailmentPlanner } from '../../lib/plan/inverterCurtailment';
import { NO_STORAGE_RELIEF, type StorageRelief } from '../../lib/plan/battery/storageRelief';
import type { InverterControllableInput, InverterPlanInput } from '../../lib/ports/inverterControl';
import type { PlanEngineState } from '../utils/planEngineStateFixture';
import { partialDouble } from '../helpers/partialDouble';

const NOW = 1_800_000_000_000;
const inverter = (deviceId = 'pv'): InverterControllableInput => ({
  kind: 'controllable', deviceId, surface: { maxW: 6000, stepW: 1, mode: 'direct', authority: 'limit_and_release' }, enabled: true, notBeforeMs: 0,
  observation: {
    production: { value: 5000, observedAtMs: NOW },
    limit: { value: 6000, observedAtMs: NOW },
    mode: { kind: 'direct' },
  },
  ownership: { kind: 'free' },
});
const held = (input = inverter()): InverterControllableInput => ({ ...input,
  ownership: { kind: 'held', recovering: false,
    claim: { previousLimitW: 6000, previousMode: { kind: 'direct' }, claimedAtMs: NOW - 60_000, restoration: { kind: 'native', binding: input.surface } } },
});
const planner = (inputs: InverterPlanInput[], costly = true) => new InverterCurtailmentPlanner({
  inputs: () => inputs, exportCostly: () => costly,
});

const batteryCharge = (setpointW: number, withheldW: number): StorageRelief => ({
  ...NO_STORAGE_RELIEF,
  batteries: [{
    deviceId: 'battery', reading: 'observed', claimHeld: true, powerLimitOff: false,
    claim: 'plan_solar', decision: { kind: 'setpoint', setpointW, stepW: 5 },
    setpointW, withheldW, heldBackChargeW: 0, creditW: 0,
  }],
});

describe('price-driven solar production limits', () => {
  it('keeps household consumption, reducing only excess export', () => {
    expect(planner([inverter()]).decide(-3000, NOW, 0, null)).toMatchObject([
      { kind: 'limit', deviceId: 'pv', limitW: 2050 },
    ]);
  });

  it('does not claim an inverter while importing, or without an opt-in', () => {
    expect(planner([inverter()]).decide(500, NOW, 0, null)).toEqual([]);
    expect(planner([{ ...inverter(), enabled: false }]).decide(-3000, NOW, 0, null)).toEqual([]);
  });

  it('returns held inverters when export is profitable, zero, or not priced', () => {
    expect(planner([held()], false).decide(-3000, NOW, 0, null)).toEqual([{ kind: 'release', deviceId: 'pv' }]);
    expect(planner([inverter()], false).decide(-3000, NOW, 0, null)).toEqual([]);
  });

  it('opens production when an additional household load starts importing', () => {
    const input = held();
    expect(planner([input]).decide(1000, NOW, 0, null)).toMatchObject([{ kind: 'limit', limitW: 6000 }]);
  });

  it('shares reduction by actual output so a shaded inverter cannot strand the allowance', () => {
    const shaded = inverter('shaded');
    shaded.observation.production.value = 1000;
    const sunny = inverter('sunny');
    sunny.observation.production.value = 5000;
    const decisions = planner([shaded, sunny]).decide(-3000, NOW, 0, null);
    expect(decisions).toMatchObject([
      { deviceId: 'shaded', limitW: 509 }, { deviceId: 'sunny', limitW: 2542 },
    ]);
  });

  it('does not raise an existing owner limit', () => {
    const input = held();
    input.ownership = { kind: 'held', recovering: false,
      claim: { previousLimitW: 2500, previousMode: { kind: 'direct' }, claimedAtMs: NOW - 60_000, restoration: { kind: 'native', binding: input.surface } } };
    expect(planner([input]).decide(2000, NOW, 0, null)).toMatchObject([{ limitW: 2500 }]);
  });

  it('uses the full native range while the inverter runs an autonomous custom mode', () => {
    const input = inverter();
    input.surface = { ...input.surface, mode: 'switchable', modeValues: ['device', 'homey', 'eco'] };
    input.observation = { ...input.observation, limit: { value: 0, observedAtMs: NOW },
      mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW } };
    expect(planner([input]).decide(-3000, NOW, 0, null)).toMatchObject([{ kind: 'limit', limitW: 2050 }]);
  });

  it('keeps the minimum dispatch interval but releases a disabled inverter at once', () => {
    const input = { ...held(), notBeforeMs: NOW + 30_000 };
    expect(planner([input]).decide(-3000, NOW, 0, null)).toEqual([]);
    expect(planner([{ ...input, enabled: false }]).decide(-3000, NOW, 0, null))
      .toEqual([{ kind: 'release', deviceId: 'pv' }]);
  });

  it('recovers old claims before allowing new curtailment and releases on meter silence', () => {
    const input = held();
    input.ownership = { kind: 'held', claim: {
      previousLimitW: 6000, previousMode: { kind: 'direct' }, claimedAtMs: NOW - 60_000, restoration: { kind: 'native', binding: input.surface },
    }, recovering: true };
    expect(planner([input]).decide(-3000, NOW, 0, null)).toEqual([{ kind: 'release', deviceId: 'pv' }]);
    expect(planner([held(), inverter('free')]).releaseAll()).toEqual([{ kind: 'release', deviceId: 'pv' }]);
  });

  it('lets a willing solar load finish settling before reducing production', () => {
    const state = partialDouble<PlanEngineState>({
      surplusEligibilityByDevice: { tank: { eligible: false, pendingSinceMs: NOW } },
      pendingBinaryCommands: {}, pendingTargetCommands: {},
    });
    const decisions = planner([inverter()]).decide(-3000, NOW, 0, null);
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(), NO_STORAGE_RELIEF, 0)).toEqual([]);
    state.surplusEligibilityByDevice = {};
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(), NO_STORAGE_RELIEF, 0)).toEqual(decisions);
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(['tank']), NO_STORAGE_RELIEF, 0)).toEqual([]);
  });

  it('keeps solar available until a planned battery charge is observed, then curtails the remainder', () => {
    const state = partialDouble<PlanEngineState>({
      surplusEligibilityByDevice: {}, pendingBinaryCommands: {}, pendingTargetCommands: {},
    });
    const decisions = planner([inverter()]).decide(-3000, NOW, 0, null);
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(), batteryCharge(2000, 2000), 0)).toEqual([]);
    // Within the storage owner's confirmation tolerance, the charge has landed.
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(), batteryCharge(2000, 100), 0))
      .toEqual(decisions);
    // Stored-energy supply is withheld from admission, but is not pending charging demand.
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(), batteryCharge(-2000, 2000), 0))
      .toEqual(decisions);
    // Hand-back and production increases must remain executable while charging settles.
    const reopening = planner([held()]).decide(1000, NOW, 0, null);
    const release = planner([held()], false).decide(-3000, NOW, 0, null);
    expect(retainSolarWhileDemandSettles(reopening, state, [], new Set(), batteryCharge(2000, 2000), 0))
      .toEqual(reopening);
    expect(retainSolarWhileDemandSettles(release, state, [], new Set(), batteryCharge(2000, 2000), 0))
      .toEqual(release);
  });
});

describe('curtailing for a phase exporting past its target', () => {
  it('limits production by the excess even when export is not costly', () => {
    expect(planner([inverter()], false).decide(-2000, NOW, 1500, null)).toEqual([
      expect.objectContaining({ kind: 'limit', deviceId: 'pv', limitW: 3500 }),
    ]);
  });

  it('acts when the net is importing, since only the phase is over', () => {
    expect(planner([inverter()], false).decide(800, NOW, 1500, null)).toEqual([
      expect.objectContaining({ kind: 'limit', limitW: 3500 }),
    ]);
  });

  it('stays out of it without an excess when export is not costly', () => {
    expect(planner([inverter()], false).decide(-2000, NOW, 0, null)).toEqual([]);
  });
});

describe('inverter held for a phase', () => {
  const capped = (limitW: number): InverterControllableInput => {
    const base = held();
    return { ...base, observation: { ...base.observation, limit: { value: limitW, observedAtMs: NOW } } };
  };

  it('stays held until the phase has room for what it holds back', () => {
    expect(planner([capped(3500)], false).decide(-500, NOW, 0, 1000)).toEqual([]);
    expect(planner([capped(3500)], false).decide(-500, NOW, 0, 3000)).toEqual([{ kind: 'release', deviceId: 'pv' }]);
  });

  it('is released as before without phase protection', () => {
    expect(planner([capped(3500)], false).decide(-500, NOW, 0, null)).toEqual([{ kind: 'release', deviceId: 'pv' }]);
  });

  it('is not held back by the settle window its own excess opened', () => {
    const base = inverter();
    const decisions = [{
      kind: 'limit' as const, deviceId: 'pv', limitW: 4000, binding: base.surface, observation: base.observation,
    }];
    const state = partialDouble<PlanEngineState>({
      surplusEligibilityByDevice: { tank: { pendingSinceMs: NOW } }, pendingBinaryCommands: {}, pendingTargetCommands: {},
    });
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(), NO_STORAGE_RELIEF, 1)).toEqual(decisions);
  });
});

describe('how far a phase overload may take production', () => {
  const producing = (productionW: number): InverterControllableInput => {
    const base = inverter();
    return { ...base, observation: { ...base.observation, production: { value: productionW, observedAtMs: NOW } } };
  };
  const limitOf = (decisions: readonly { kind: string; limitW?: number }[]): number | undefined => (
    decisions.find((decision) => decision.kind === 'limit')?.limitW
  );

  it('never goes below three times the excess from where the breach began', () => {
    const inputs: InverterPlanInput[] = [producing(5000)];
    const source = new InverterCurtailmentPlanner({ inputs: () => inputs, exportCostly: () => false });
    expect(limitOf(source.decide(0, NOW, 1000, 0))).toBe(4000);
    inputs[0] = producing(2100);
    // The phase answered, so lowering goes on, but not past 5000 - 3 x 1000.
    expect(limitOf(source.decide(0, NOW + 10_000, 500, 0))).toBe(2000);
  });

  it('stops lowering once a real drop did nothing for the phase', () => {
    const inputs: InverterPlanInput[] = [producing(5000)];
    const source = new InverterCurtailmentPlanner({ inputs: () => inputs, exportCostly: () => false });
    source.decide(0, NOW, 500, 0);
    inputs[0] = producing(4000);
    expect(limitOf(source.decide(0, NOW + 10_000, 500, 0))).toBe(4000);
    expect(limitOf(source.decide(0, NOW + 20_000, 500, 0))).toBe(4000);
  });
});
