import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import type { PlanEngineState } from '../utils/planEngineStateFixture';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { buildPlanInputDevice, NO_STORAGE_SURPLUS, resolveSurplusEligibilityForSpec } from '../utils/planTestUtils';
import { resolvePriceOptimizationConfig } from '../../lib/price/priceOptimizer';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import type { PhaseFootprint } from '../../packages/planner-types/src/phaseFootprint';
import type { MainFuse, PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { DevicePlan } from '../../lib/plan/planTypes';

const FUSE: MainFuse = { kind: 'on', supply: 'three_phase_neutral', amps: 25 };
// The fuse's total, as the settings store applies it to the grid axis.
const LIMITS: PowerLimitSettings = {
  capacityEnabled: false, gridImportLimitKw: 17.25, limitKw: 30, marginKw: 0.2, periodMinutes: 60,
};

type PhasesKw = readonly [number, number, number];

const load = (id: string, kw: number, footprint: PhaseFootprint, priority: number) => buildPlanInputDevice({
  id, name: id, deviceType: 'onoff', currentDrawKw: kw, expectedPowerKw: kw, targets: [],
  binaryControl: { on: true }, phaseFootprint: footprint, priority,
});
const L1: PhaseFootprint = { kind: 'single', phase: 'L1' };
const L2: PhaseFootprint = { kind: 'single', phase: 'L2' };
const ALL: PhaseFootprint = { kind: 'all_three' };
const UNKNOWN: PhaseFootprint = { kind: 'unknown' };

const buildCycle = (state: PlanEngineState, phasesKw: PhasesKw, fuse: MainFuse = FUSE, limits = LIMITS) => {
  const netKw = phasesKw.reduce((sum, kw) => sum + kw, 0);
  const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
  capacityGuard.phaseReadings.admit({
    state: 'read', capabilityIds: [], powerW: phasesKw.map((kw) => kw * 1000) as unknown as readonly [number, number, number],
  }, netKw * 1000, Date.now());
  return new PlanBuilder({
    ...planBuilderWiring(),
    getMainFuse: () => fuse,
    capacityGuard,
    getCapacitySettings: () => limits,
    getPowerTracker: () => ({ buckets: {}, lastTimestamp: Date.now(), lastPowerW: netKw * 1000 }),
  }, state);
};

const batteryOn = (id: string, footprint: PhaseFootprint, signedPowerW: number) => ({
  ...buildPlanInputDevice({
    id, name: id, isBatteryOrSolar: true, currentDrawKw: 0, binaryControllable: false,
    phaseFootprint: footprint, priority: 2, targets: [],
  }),
  storage: {
    reading: 'observed' as const,
    range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false,
    signedPowerW,
    observedAtMs: Date.now(),
    claimHeld: false,
    admissible: true,
    powerLimitControl: true,
    verdict: 'unverified' as const,
    deliveryCeilingW: 2500,
    chargeCeilingW: 2500,
    ownModeGridCharge: { kind: 'observed' as const },
  },
});

const planned = (plan: DevicePlan, id: string) => plan.devices.find((device) => device.id === id);

describe('main fuse phase protection in the planner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('limits only devices on the overloaded phase when the net looks fine', async () => {
    const plan = await buildCycle(createPlanEngineState(), [6.2, -2, -2]).buildDevicePlanSnapshot([
      load('on_l1', 2, L1, 2),
      load('on_l2', 1, L2, 3),
    ]);
    expect(planned(plan, 'on_l1')).toMatchObject({ plannedState: 'shed', reason: { code: 'phase_limit', phase: 'L1' } });
    expect(planned(plan, 'on_l2')?.plannedState).toBe('keep');
  });

  it('counts a third of an all-three-phase device towards the phase', async () => {
    // L1 is 0.525 kW over, so a 3 kW three-phase load (1 kW on L1) is enough.
    const plan = await buildCycle(createPlanEngineState(), [5.7, 2, 2]).buildDevicePlanSnapshot([
      load('first', 3, ALL, 3),
      load('second', 3, ALL, 2),
    ]);
    expect(planned(plan, 'first')?.plannedState).toBe('shed');
    expect(planned(plan, 'second')?.plannedState).toBe('keep');
  });

  it('prefers known footprints and takes at most one unknown per cycle', async () => {
    const state = createPlanEngineState();
    const devices = [load('known', 0.5, L1, 1), load('a', 3, UNKNOWN, 3), load('b', 3, UNKNOWN, 2)];
    const plan = await buildCycle(state, [7.5, 1, 1]).buildDevicePlanSnapshot(devices);
    expect(planned(plan, 'known')?.plannedState).toBe('shed');
    expect(planned(plan, 'a')?.plannedState).toBe('shed');
    expect(planned(plan, 'b')?.plannedState).toBe('keep');
  });

  it('credits a shed for 30 s while its device has not delivered, then acts again', async () => {
    const state = createPlanEngineState();
    const devices = [load('first', 2, L1, 3), load('second', 2, L1, 2)];
    const first = await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot(devices);
    expect(planned(first, 'first')?.plannedState).toBe('shed');
    expect(planned(first, 'second')?.plannedState).toBe('keep');

    vi.setSystemTime(Date.now() + 2_000);
    const held = await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot(devices);
    expect(planned(held, 'first')).toMatchObject({ plannedState: 'shed', reason: { code: 'phase_limit' } });
    expect(planned(held, 'second')?.plannedState).toBe('keep');

    // Past the window nothing is credited: the command is no longer counted on.
    vi.setSystemTime(Date.now() + 31_000);
    const expired = await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot(devices);
    expect(planned(expired, 'first')?.plannedState).toBe('shed');
    expect(state.phaseShed.decisions.get('first')?.atMs).toBe(Date.now());
  });

  it('counts relief as delivered once the device has stopped drawing', async () => {
    const state = createPlanEngineState();
    await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot([load('first', 2, L1, 3), load('second', 2, L1, 2)]);
    vi.setSystemTime(Date.now() + 2_000);
    // Delivered, yet L1 still reads high: the credit is gone and the next device goes.
    const stopped = { ...load('first', 0, L1, 3), currentOn: false, binaryControl: { on: false } };
    const plan = await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot([stopped, load('second', 2, L1, 2)]);
    expect(planned(plan, 'second')?.plannedState).toBe('shed');
  });

  it('stops a battery charging on the overloaded phase, bounded by that phase, not the exporting total', async () => {
    const state = createPlanEngineState();
    const battery = {
      ...buildPlanInputDevice({
        id: 'battery', name: 'Battery', isBatteryOrSolar: true, currentDrawKw: 0, binaryControllable: false,
        phaseFootprint: L1, priority: 2, targets: [],
      }),
      storage: {
        reading: 'observed' as const,
        range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
        handBackDeferred: false,
        signedPowerW: 2000,
        observedAtMs: Date.now(),
        claimHeld: false,
        admissible: true,
        powerLimitControl: true,
        verdict: 'unverified' as const,
        deliveryCeilingW: 2500,
        chargeCeilingW: 2500,
        ownModeGridCharge: { kind: 'observed' as const },
      },
    };
    await buildCycle(state, [6.2, -4, -4]).buildDevicePlanSnapshot([battery as never]);
    expect(state.storageLeverByDevice.battery?.setpointW).toBeGreaterThanOrEqual(0);
    expect(state.storageLeverByDevice.battery?.setpointW).toBeLessThan(2000);
  });

  it('holds devices back on a phase with no room', async () => {
    const off = buildPlanInputDevice({
      id: 'heater', name: 'heater', deviceType: 'onoff', currentDrawKw: 0, expectedPowerKw: 2, targets: [],
      binaryControl: { on: false }, phaseFootprint: L1, priority: 2,
    });
    const state = createPlanEngineState();
    vi.setSystemTime(Date.now() + 700_000);
    const plan = await buildCycle(state, [4, 0.5, 0.5]).buildDevicePlanSnapshot([off]);
    expect(planned(plan, 'heater')?.plannedState).toBe('shed');
  });

  it('names the phase when nothing managed can relieve it', async () => {
    const plan = await buildCycle(createPlanEngineState(), [6.2, 1, 1]).buildDevicePlanSnapshot([load('other', 2, L2, 2)]);
    expect(plan.meta).toMatchObject({ unrelievedPhase: 'L1' });
  });

  it('holds the next unknown back while the last one is still responding', async () => {
    const state = createPlanEngineState();
    const devices = [load('a', 3, UNKNOWN, 3), load('b', 3, UNKNOWN, 2)];
    await buildCycle(state, [7.5, 1, 1]).buildDevicePlanSnapshot(devices);
    vi.setSystemTime(Date.now() + 2_000);
    const plan = await buildCycle(state, [7.5, 1, 1]).buildDevicePlanSnapshot(devices);
    expect(planned(plan, 'a')?.plannedState).toBe('shed');
    expect(planned(plan, 'b')?.plannedState).toBe('keep');
  });

  it('counts relief the scalar pass took on this phase', async () => {
    const limits = { ...LIMITS, gridImportLimitKw: 8 };
    const plan = await buildCycle(createPlanEngineState(), [6.2, 1.5, 1.5], FUSE, limits).buildDevicePlanSnapshot([
      load('scalar_choice', 2, L1, 3),
      load('next_on_l1', 2, L1, 2),
    ]);
    expect(planned(plan, 'scalar_choice')).toMatchObject({ plannedState: 'shed', reason: { code: 'grid_import' } });
    expect(planned(plan, 'next_on_l1')?.plannedState).toBe('keep');
  });

  it('leaves a scalar decision in place over a phase hold, keeping the credit', async () => {
    const state = createPlanEngineState();
    const devices = [load('first', 2, L1, 3)];
    await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot(devices);
    vi.setSystemTime(Date.now() + 2_000);
    const limits = { ...LIMITS, gridImportLimitKw: 7 };
    const plan = await buildCycle(state, [6.2, 1, 1], FUSE, limits).buildDevicePlanSnapshot(devices);
    expect(planned(plan, 'first')).toMatchObject({ plannedState: 'shed', reason: { code: 'grid_import' } });
    expect(state.phaseShed.decisions.has('first')).toBe(true);
  });

  it('spends nothing new on a rebuild of the same sample', async () => {
    const state = createPlanEngineState();
    await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot([load('first', 2, L1, 3), load('second', 2, L1, 2)]);
    // A settings rebuild on the same reading, after the first device reports off.
    const stopped = { ...load('first', 0, L1, 3), currentOn: false, binaryControl: { on: false } };
    const plan = await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot([stopped, load('second', 2, L1, 2)]);
    expect(planned(plan, 'second')?.plannedState).toBe('keep');
  });

  it('keeps a phase breach out of the scalar physical-limit verdict', async () => {
    const plan = await buildCycle(createPlanEngineState(), [6.2, -2, -2]).buildDevicePlanSnapshot([load('a', 2, L1, 2)]);
    expect(plan.meta).toMatchObject({ physicalLimitBreached: false });
  });

  it('does not claim nothing is left while a device was limited on that phase this cycle', async () => {
    const plan = await buildCycle(createPlanEngineState(), [8, 1, 1]).buildDevicePlanSnapshot([load('only', 0.5, L1, 2)]);
    expect(planned(plan, 'only')?.plannedState).toBe('shed');
    expect(plan.meta).toMatchObject({ unrelievedPhase: null });
  });

  it('does not let export on other phases lift a device on a phase at its target', () => {
    const dumpLoad = buildPlanInputDevice({
      id: 'dump', name: 'dump', deviceType: 'onoff', currentDrawKw: 0, expectedPowerKw: 1, targets: [],
      binaryControl: { on: false }, surplusOnly: true, phaseFootprint: L1, priority: 2,
    });
    const settledEligibility = (phase: Parameters<typeof resolveSurplusEligibilityForSpec>[0]['phase']) => {
      const state = createPlanEngineState();
      const run = () => resolveSurplusEligibilityForSpec({
        devices: [dumpLoad], state, signedNetKw: -4, inferredSurplusKw: 0, storage: NO_STORAGE_SURPLUS,
        excludeIds: new Set(), getConfig: (id) => resolvePriceOptimizationConfig({}, id), nowTs: Date.now(), phase,
      });
      run();
      vi.setSystemTime(Date.now() + 120_000);
      run();
      return state.surplusEligibilityByDevice.dump?.eligible === true;
    };
    const measured = (phase: 'L1', drawKw: number) => ({ phase, drawKw, targetKw: 5.175, roomKw: 5.175 - drawKw, breached: false, exportBreached: false, exportExcessKw: 0 });
    expect(settledEligibility({ kind: 'off' })).toBe(true);
    expect(settledEligibility({ kind: 'on', phases: [
      measured('L1', 5.1), { ...measured('L1', -4), phase: 'L2' }, { ...measured('L1', -5), phase: 'L3' },
    ] })).toBe(false);
  });

  it('says which phase an unknown device waits for, and offers the setting only then', async () => {
    const off = (footprint: PhaseFootprint) => buildPlanInputDevice({
      id: 'heater', name: 'heater', deviceType: 'onoff', currentDrawKw: 0, expectedPowerKw: 2, targets: [],
      binaryControl: { on: false }, phaseFootprint: footprint, priority: 2,
    });
    vi.setSystemTime(Date.now() + 700_000);
    const plan = await buildCycle(createPlanEngineState(), [4.5, 1, 1]).buildDevicePlanSnapshot([off(UNKNOWN)]);
    expect(planned(plan, 'heater')).toMatchObject({ plannedState: 'shed', reason: { code: 'phase_limit', phase: 'L1' } });
  });

  it('discharges a battery on the phase to cover its import, within that import', async () => {
    const state = createPlanEngineState();
    await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot([batteryOn('battery', L1, 0) as never]);
    expect(state.storageLeverByDevice.battery?.setpointW).toBeLessThan(0);
    // Its deficit is about 1 kW, well inside what L1 imports, so it stops there.
    expect(state.storageLeverByDevice.battery?.setpointW).toBeGreaterThan(-2000);
  });

  it('only cuts the charge of a battery on an unknown phase', async () => {
    const state = createPlanEngineState();
    await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot([batteryOn('battery', UNKNOWN, 2000) as never]);
    expect(state.storageLeverByDevice.battery?.setpointW).toBeGreaterThanOrEqual(0);
    expect(state.storageLeverByDevice.battery?.setpointW).toBeLessThan(2000);
  });

  it('credits the discharge a battery is asked for, so the next device is left alone', async () => {
    const plan = await buildCycle(createPlanEngineState(), [6.2, 1, 1]).buildDevicePlanSnapshot([
      batteryOn('battery', L1, 0) as never,
      load('heater', 2, L1, 1),
    ]);
    expect(planned(plan, 'heater')?.plannedState).toBe('keep');
  });

  it('keeps a held discharge in place while its phase has no room to take it back', async () => {
    const state = createPlanEngineState();
    const battery = batteryOn('battery', L1, -1000);
    await buildCycle(state, [6.2, 1, 1]).buildDevicePlanSnapshot([battery as never]);
    const held = state.storageLeverByDevice.battery?.setpointW ?? 0;
    expect(held).toBeLessThan(0);
    vi.setSystemTime(Date.now() + 700_000);
    await buildCycle(state, [5.1, 1, 1]).buildDevicePlanSnapshot([{ ...battery, storage: { ...battery.storage, signedPowerW: held } } as never]);
    expect(state.storageLeverByDevice.battery?.setpointW).toBe(held);
  });

  it('never limits a load for an export overload, and turns a battery on that phase down', async () => {
    const state = createPlanEngineState();
    const plan = await buildCycle(state, [-6.2, 1, 1]).buildDevicePlanSnapshot([
      load('heater', 2, L1, 2),
      batteryOn('battery', L1, -2000) as never,
    ]);
    expect(planned(plan, 'heater')?.plannedState).toBe('keep');
    expect(state.storageLeverByDevice.battery?.setpointW).toBeGreaterThan(-2000);
    expect(plan.meta).toMatchObject({ exportPhase: 'L1' });
  });

  it('does not hand a battery back onto a phase with no export room for its discharge', async () => {
    const state = createPlanEngineState();
    const battery = batteryOn('battery', L1, -2000);
    await buildCycle(state, [-6.2, 1, 1]).buildDevicePlanSnapshot([battery as never]);
    const lever = state.storageLeverByDevice.battery;
    expect(lever?.exportPhase).toBe('L1');
    vi.setSystemTime(Date.now() + 700_000);
    const lowered = { ...battery, storage: { ...battery.storage, signedPowerW: lever?.setpointW ?? 0 } };
    await buildCycle(state, [-5, 1, 1]).buildDevicePlanSnapshot([lowered as never]);
    expect(state.storageLeverByDevice.battery).toBeDefined();
  });

  it('keeps an export-phase hold within the battery\'s delivery ceiling', async () => {
    const state = createPlanEngineState();
    const battery = batteryOn('battery', L1, -2000);
    await buildCycle(state, [-6.2, 1, 1]).buildDevicePlanSnapshot([battery as never]);
    const held = state.storageLeverByDevice.battery;
    expect(held?.exportPhase).toBe('L1');
    vi.setSystemTime(Date.now() + 1_000);
    const lowCeiling = {
      ...battery, storage: { ...battery.storage, signedPowerW: held?.setpointW ?? 0, deliveryCeilingW: 100 },
    };
    await buildCycle(state, [-5, 1, 1]).buildDevicePlanSnapshot([lowCeiling as never]);
    expect(state.storageLeverByDevice.battery?.setpointW).toBeGreaterThanOrEqual(-100);
  });

  it('sizes the hand-back gate by the phase share, so a three-phase battery can go home', async () => {
    const state = createPlanEngineState();
    const battery = batteryOn('battery', ALL, -3000);
    await buildCycle(state, [-6.2, 1, 1]).buildDevicePlanSnapshot([battery as never]);
    expect(state.storageLeverByDevice.battery?.exportPhase).toBe('L1');
    vi.setSystemTime(Date.now() + 700_000);
    const lowered = { ...battery, storage: { ...battery.storage, signedPowerW: state.storageLeverByDevice.battery?.setpointW ?? 0 } };
    // L1 has room for a third of the returning discharge, not all of it.
    await buildCycle(state, [-4, 1, 1]).buildDevicePlanSnapshot([lowered as never]);
    expect(state.storageLeverByDevice.battery).toBeUndefined();
  });

  it('asks the inverter for what the batteries left, whatever the price says', async () => {
    const decide = vi.fn().mockReturnValue([]);
    const state = createPlanEngineState();
    const builder = new PlanBuilder({
      ...planBuilderWiring(),
      inverterCurtailment: { decide, releaseAll: () => [] },
      getMainFuse: () => FUSE,
      capacityGuard: (() => {
        const guard = createTestCapacityGuard({ homeId: 'main' });
        guard.phaseReadings.admit({ state: 'read', capabilityIds: [], powerW: [-6200, 1000, 1000] }, -4200, Date.now());
        return guard;
      })(),
      getCapacitySettings: () => LIMITS,
      getPowerTracker: () => ({ buckets: {}, lastTimestamp: Date.now(), lastPowerW: -4200 }),
    }, state);
    await builder.buildDevicePlanSnapshot([]);
    expect(decide).toHaveBeenCalledWith(-4200, expect.any(Number), expect.closeTo(1025), expect.any(Number));
  });

  it('does nothing different without a fuse', async () => {
    const devices = [load('on_l1', 2, L1, 2)];
    const withoutFuse = await buildCycle(createPlanEngineState(), [6.2, -2, -2], { kind: 'off' })
      .buildDevicePlanSnapshot(devices);
    expect(planned(withoutFuse, 'on_l1')?.plannedState).toBe('keep');
    expect(withoutFuse.meta).toMatchObject({ phase: { kind: 'off' }, unrelievedPhase: null, physicalLimitBreached: false });
  });
});
