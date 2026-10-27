import { describe, expect, it } from 'vitest';
import { retainSolarWhileDemandSettles } from '../../lib/plan/planBuilderSurplus';
import { InverterCurtailmentPlanner } from '../../lib/plan/inverterCurtailment';
import type { InverterControllableInput, InverterPlanInput } from '../../lib/ports/inverterControl';
import type { PlanEngineState } from '../../lib/plan/planState';
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

describe('price-driven solar production limits', () => {
  it('keeps household consumption, reducing only excess export', () => {
    expect(planner([inverter()]).decide(-3000, NOW)).toMatchObject([
      { kind: 'limit', deviceId: 'pv', limitW: 2050 },
    ]);
  });

  it('does not claim an inverter while importing, or without an opt-in', () => {
    expect(planner([inverter()]).decide(500, NOW)).toEqual([]);
    expect(planner([{ ...inverter(), enabled: false }]).decide(-3000, NOW)).toEqual([]);
  });

  it('returns held inverters when export is profitable, zero, or not priced', () => {
    expect(planner([held()], false).decide(-3000, NOW)).toEqual([{ kind: 'release', deviceId: 'pv' }]);
    expect(planner([inverter()], false).decide(-3000, NOW)).toEqual([]);
  });

  it('opens production when an additional household load starts importing', () => {
    const input = held();
    expect(planner([input]).decide(1000, NOW)).toMatchObject([{ kind: 'limit', limitW: 6000 }]);
  });

  it('shares reduction by actual output so a shaded inverter cannot strand the allowance', () => {
    const shaded = inverter('shaded');
    shaded.observation.production.value = 1000;
    const sunny = inverter('sunny');
    sunny.observation.production.value = 5000;
    const decisions = planner([shaded, sunny]).decide(-3000, NOW);
    expect(decisions).toMatchObject([
      { deviceId: 'shaded', limitW: 509 }, { deviceId: 'sunny', limitW: 2542 },
    ]);
  });

  it('does not raise an existing owner limit', () => {
    const input = held();
    input.ownership = { kind: 'held', recovering: false,
      claim: { previousLimitW: 2500, previousMode: { kind: 'direct' }, claimedAtMs: NOW - 60_000, restoration: { kind: 'native', binding: input.surface } } };
    expect(planner([input]).decide(2000, NOW)).toMatchObject([{ limitW: 2500 }]);
  });

  it('uses the full native range while the inverter runs an autonomous custom mode', () => {
    const input = inverter();
    input.surface = { ...input.surface, mode: 'switchable', modeValues: ['device', 'homey', 'eco'] };
    input.observation = { ...input.observation, limit: { value: 0, observedAtMs: NOW },
      mode: { kind: 'autonomous', value: 'eco', observedAtMs: NOW } };
    expect(planner([input]).decide(-3000, NOW)).toMatchObject([{ kind: 'limit', limitW: 2050 }]);
  });

  it('keeps the minimum dispatch interval but releases a disabled inverter at once', () => {
    const input = { ...held(), notBeforeMs: NOW + 30_000 };
    expect(planner([input]).decide(-3000, NOW)).toEqual([]);
    expect(planner([{ ...input, enabled: false }]).decide(-3000, NOW))
      .toEqual([{ kind: 'release', deviceId: 'pv' }]);
  });

  it('recovers old claims before allowing new curtailment and releases on meter silence', () => {
    const input = held();
    input.ownership = { kind: 'held', claim: {
      previousLimitW: 6000, previousMode: { kind: 'direct' }, claimedAtMs: NOW - 60_000, restoration: { kind: 'native', binding: input.surface },
    }, recovering: true };
    expect(planner([input]).decide(-3000, NOW)).toEqual([{ kind: 'release', deviceId: 'pv' }]);
    expect(planner([held(), inverter('free')]).releaseAll()).toEqual([{ kind: 'release', deviceId: 'pv' }]);
  });

  it('lets a willing solar load finish settling before reducing production', () => {
    const state = partialDouble<PlanEngineState>({
      surplusEligibilityByDevice: { tank: { eligible: false, pendingSinceMs: NOW } },
      pendingBinaryCommands: {}, pendingTargetCommands: {},
    });
    const decisions = planner([inverter()]).decide(-3000, NOW);
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set())).toEqual([]);
    state.surplusEligibilityByDevice = {};
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set())).toEqual(decisions);
    expect(retainSolarWhileDemandSettles(decisions, state, [], new Set(['tank']))).toEqual([]);
  });
});
