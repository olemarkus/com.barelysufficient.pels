import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChargingPhaseControlOwner, CHARGING_PHASE_CONFIRMATION_MS,
  CHARGING_PHASE_DWELL_MS } from '../../lib/chargingPhases/chargingPhaseControlOwner';
import { ExecutionOnlyChargingPhases } from '../../lib/chargingPhases/executionOnlyChargingPhases';
import { ChargingPhaseExecutor } from '../../lib/executor/chargingPhaseExecutor';
import { CHARGING_PHASE_RECORD_PREFIX } from '../../lib/chargingPhases/phaseClaimStore';
import type { ChargingPhaseActuation, ChargingPhaseCommandAuthority, ChargingPhaseDevice,
  ChargingPhasePauseRecording, ChargingPhaseSource } from '../../lib/ports/chargingPhases';
import type { ChargingPhaseDecision } from '../../lib/planContract/chargingPhaseDecision';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { ControlContestRecording } from '../../lib/ports/controlContest';
import type { ChargingPhaseCount } from '../../packages/contracts/src/chargingPhases';
import { CHARGING_PHASE_SETTINGS_KEY } from '../../packages/shared-domain/src/settings/chargingPhases';

const NOW = Date.UTC(2026, 10, 13, 10);
const ID = 'charger';
const RECORD_KEY = `${CHARGING_PHASE_RECORD_PREFIX}${ID}`;

function fixture() {
  const values = new Map<string, unknown>([[CHARGING_PHASE_SETTINGS_KEY,
    { [ID]: { mode: 'single', installationConfirmed: true } }]]);
  const settings: SettingsPort = {
    get: (key) => values.get(key),
    set: (key, value) => { values.set(key, value); },
    unset: (key) => { values.delete(key); },
    getKeys: () => [...values.keys()],
  };
  let device: ChargingPhaseDevice = {
    deviceId: ID, available: true, connected: true, managed: true, controlEnabled: true,
    forceSinglePhase: false, forceSinglePhaseObservedAtMs: NOW,
    currentLimitA: 6, minimumCurrentA: 6, maximumCurrentA: 16, configuredPhases: 3, planningPhases: 3, drawingPhases: 3,
    powers: [{ watts: 1380, observedAtMs: NOW }, { watts: 1380, observedAtMs: NOW }, { watts: 1380, observedAtMs: NOW }],
    totalPower: { watts: 4140, observedAtMs: NOW },
  };
  let simulation = false;
  const source: ChargingPhaseSource = {
    readDevices: () => [device],
    isSimulation: () => simulation,
    releasePlanningEnvelope: vi.fn((_id, forceSinglePhase) => {
      device = { ...device, planningPhases: forceSinglePhase ? 1 : 3 };
    }),
    envelopes: () => ([1, 3] as const).map((phases) => ({
      phases, footprint: phases === 1 ? { kind: 'single' as const, phase: 'L1' as const } : { kind: 'all_three' as const },
      profile: { steps: [{ id: 'off', planningPowerW: 0 },
        { id: '6a', planningCurrentA: 6, planningPowerW: phases * 1380 },
        { id: '16a', planningCurrentA: 16, planningPowerW: phases * 3680 }] },
    })),
    observedPoint: (read, phases) => ({
      phases, currentA: read.currentLimitA, totalKw: read.totalPower.watts / 1000,
      perPhaseKw: { L1: read.powers[0].watts / 1000, L2: read.powers[1].watts / 1000, L3: read.powers[2].watts / 1000 },
    }),
  };
  const apply = vi.fn<ChargingPhaseActuation['apply']>().mockResolvedValue({ requested: true });
  const actuation: ChargingPhaseActuation = { apply };
  const contest: ControlContestRecording = {
    commandSent: vi.fn(), controlReported: vi.fn(), commandReleased: vi.fn(), retainPlanned: vi.fn(),
  };
  const pauses: ChargingPhasePauseRecording = {
    forDevice: () => ({ onStarting: vi.fn(), onAccepted: vi.fn(), onFailed: vi.fn() }),
  };
  const create = () => new ChargingPhaseControlOwner(settings, source, actuation, contest, pauses);
  return {
    values, settings, source, apply, create, contest, owner: create(),
    setDevice: (patch: Partial<ChargingPhaseDevice>) => { device = { ...device, ...patch }; },
    setSimulation: (enabled: boolean) => { simulation = enabled; },
  };
}

function switchDecision(phases: ChargingPhaseCount): ChargingPhaseDecision {
  return { kind: 'switch', deviceId: ID,
    target: { phases, currentA: 6, totalKw: phases * 1.38,
      perPhaseKw: { L1: 1.38, L2: phases === 3 ? 1.38 : 0, L3: phases === 3 ? 1.38 : 0 } },
    reservation: { deviceId: ID, totalKw: 4.14, perPhaseKw: { L1: 1.38, L2: 1.38, L3: 1.38 } } };
}

function singlePhaseRead(observedAtMs: number): Pick<ChargingPhaseDevice, 'powers' | 'totalPower' | 'planningPhases' | 'drawingPhases'> {
  return { planningPhases: 1, drawingPhases: 1, powers: [{ watts: 1380, observedAtMs }, { watts: 0, observedAtMs }, { watts: 0, observedAtMs }],
    totalPower: { watts: 1380, observedAtMs } };
}

describe('physical charging-phase ownership', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  it('persists the original setting before asking the actuator and ignores an optimistic phase echo', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    f.apply.mockImplementation(async () => {
      expect(f.values.get(RECORD_KEY)).toMatchObject({ kind: 'held', originalForceSingle: false });
      f.setDevice({ forceSinglePhase: true });
      return { requested: true };
    });
    await f.owner.apply(switchDecision(1), NOW + 1);
    const waiting = f.owner.readPlanning(NOW + 10_000);
    expect(f.owner.blocksIncrease(ID)).toBe(true);
    expect(waiting.reservations).toEqual([{ deviceId: ID, totalKw: 4.14,
      perPhaseKw: { L1: 1.38, L2: 1.38, L3: 1.38 } }]);
    expect(f.owner.read(ID)).toMatchObject({ status: { kind: 'switching', from: 3, to: 1 } });
    f.setDevice(singlePhaseRead(NOW + 20_000));
    f.owner.readPlanning(NOW + 20_001);
    expect(f.owner.blocksIncrease(ID)).toBe(false);
    expect(f.owner.read(ID)).toMatchObject({ status: { kind: 'waiting', phases: 1 } });
  });

  it('keeps the reservation through a firmware idle dip and times out without inventing phase evidence', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.setDevice({ forceSinglePhase: true, totalPower: { watts: 0, observedAtMs: NOW + 1000 },
      powers: [{ watts: 0, observedAtMs: NOW + 1000 }, { watts: 0, observedAtMs: NOW + 1000 },
        { watts: 0, observedAtMs: NOW + 1000 }] });
    expect(f.owner.readPlanning(NOW + 30_000).reservations[0]?.totalKw).toBe(4.14);
    const failed = f.owner.readPlanning(NOW + CHARGING_PHASE_CONFIRMATION_MS + 2);
    expect(failed.candidates).toEqual([]);
    expect(failed.releases).toEqual([{ kind: 'release', deviceId: ID }]);
    expect(f.owner.blocksIncrease(ID)).toBe(true);
  });

  it('does not treat a split phase-power publication as confirmation while total power contradicts it', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.setDevice({ forceSinglePhase: true, ...singlePhaseRead(NOW + 1000),
      totalPower: { watts: 4140, observedAtMs: NOW + 1000 } });
    f.owner.readPlanning(NOW + 1001);
    expect(f.owner.blocksIncrease(ID)).toBe(true);
    f.setDevice({ totalPower: { watts: 1380, observedAtMs: NOW + 2000 } });
    f.owner.readPlanning(NOW + 2001);
    expect(f.owner.blocksIncrease(ID)).toBe(false);
  });

  it('keeps a failed connection locked after hand-back until a physical disconnect', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.owner.readPlanning(NOW + CHARGING_PHASE_CONFIRMATION_MS + 2);
    await f.owner.apply({ kind: 'release', deviceId: ID }, NOW + CHARGING_PHASE_CONFIRMATION_MS + 3);
    f.owner.readPlanning(NOW + CHARGING_PHASE_DWELL_MS + 10);
    expect(f.owner.readPlanning(NOW + CHARGING_PHASE_DWELL_MS + 20).candidates).toEqual([]);
    f.setDevice({ connected: false });
    f.owner.readPlanning(NOW + CHARGING_PHASE_DWELL_MS + 30);
    f.setDevice({ connected: true });
    expect(f.owner.readPlanning(NOW + CHARGING_PHASE_DWELL_MS + 40).candidates).toHaveLength(1);
  });

  it('recovers an interrupted claim before allowing a new takeover, including a crash before the write', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    f.apply.mockRejectedValueOnce(new Error('process interrupted after durable claim'));
    await expect(f.owner.apply(switchDecision(1), NOW + 1)).rejects.toThrow('process interrupted');
    const recovered = f.create();
    const read = recovered.readPlanning(NOW + 1000);
    expect(read.candidates).toEqual([]);
    expect(read.releases).toEqual([{ kind: 'release', deviceId: ID }]);
    await recovered.apply(read.releases[0], NOW + 1001);
    recovered.readPlanning(NOW + 1002);
    expect(f.values.get(RECORD_KEY)).toMatchObject({ kind: 'free' });
    expect(recovered.blocksIncrease(ID)).toBe(true);
    recovered.readPlanning(NOW + 1003);
    expect(recovered.blocksIncrease(ID)).toBe(false);
  });

  it.each(['simulation', 'unmanage', 'disable'] as const)('hands back when %s takes ownership away', async (reason) => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.setDevice({ forceSinglePhase: true, ...singlePhaseRead(NOW + 1000) });
    f.owner.readPlanning(NOW + 1001);
    if (reason === 'simulation') f.setSimulation(true);
    if (reason === 'unmanage') f.setDevice({ managed: false });
    if (reason === 'disable') f.values.delete(CHARGING_PHASE_SETTINGS_KEY);
    const read = f.owner.readPlanning(NOW + 2000);
    expect(read.releases).toEqual([{ kind: 'release', deviceId: ID }]);
    await f.owner.apply(read.releases[0], NOW + 2001);
    expect(f.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'charging_phase_release', deviceId: ID,
      forceSinglePhase: false }));
    expect(f.owner.blocksIncrease(ID)).toBe(true);
    f.setDevice({ forceSinglePhase: false, totalPower: { watts: 0, observedAtMs: NOW + 3000 },
      powers: [{ watts: 0, observedAtMs: NOW + 3000 }, { watts: 0, observedAtMs: NOW + 3000 },
        { watts: 0, observedAtMs: NOW + 3000 }] });
    f.owner.readPlanning(NOW + 3001);
    expect(f.values.get(RECORD_KEY)).toMatchObject({ kind: 'free' });
  });

  it('serializes an ordinary safety reduction behind the same device phase request without delaying another device', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    let finish: () => void = () => {};
    f.apply.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ requested: true }); }));
    const phase = f.owner.apply(switchDecision(1), NOW + 1);
    const reduced = vi.fn().mockResolvedValue(undefined);
    const reduction = f.owner.runDeviceCommand(ID, reduced);
    const other = vi.fn().mockResolvedValue(undefined);
    await f.owner.runDeviceCommand('other', other);
    expect(other).toHaveBeenCalledOnce();
    expect(reduced).not.toHaveBeenCalled();
    finish();
    await Promise.all([phase, reduction]);
    expect(reduced).toHaveBeenCalledOnce();
  });

  it('leaves no physical request when the durable claim cannot be saved', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    vi.spyOn(f.settings, 'set').mockImplementation(() => { throw new Error('settings unavailable'); });
    await expect(f.owner.apply(switchDecision(1), NOW + 1)).rejects.toThrow('settings unavailable');
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.owner.blocksIncrease(ID)).toBe(false);
  });

  it('prepares a high-current one-phase session before requesting three phases', async () => {
    const f = fixture();
    f.values.set(CHARGING_PHASE_SETTINGS_KEY, { [ID]: { mode: 'three', installationConfirmed: true } });
    f.setDevice({ forceSinglePhase: true, configuredPhases: 1, planningPhases: 1, drawingPhases: 1, currentLimitA: 16, powers: [
      { watts: 3680, observedAtMs: NOW }, { watts: 0, observedAtMs: NOW }, { watts: 0, observedAtMs: NOW },
    ], totalPower: { watts: 3680, observedAtMs: NOW } });
    f.owner.readPlanning(NOW);
    const target = switchDecision(3);
    if (target.kind === 'release') throw new Error('expected phase target');
    const preparation: ChargingPhaseDecision = { ...target, kind: 'prepare' };
    await f.owner.apply(preparation, NOW + 1);
    expect(f.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'charging_phase_prepare', currentA: 6 }));
    f.setDevice({ currentLimitA: 6 }); // Setting echo precedes independently measured relief.
    f.owner.readPlanning(NOW + 1000);
    await f.owner.apply(target, NOW + 1001);
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.owner.blocksIncrease(ID)).toBe(true);
    f.setDevice(singlePhaseRead(NOW + 2000));
    f.owner.readPlanning(NOW + 2001);
    await f.owner.apply(target, NOW + 2002);
    expect(f.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'charging_phase', phases: 3, currentA: 6 }));
  });

  it('withdraws preparation without applying a phase change or leaving its increase guard forever', async () => {
    const f = fixture();
    f.values.set(CHARGING_PHASE_SETTINGS_KEY, { [ID]: { mode: 'three', installationConfirmed: true } });
    f.setDevice({ forceSinglePhase: true, configuredPhases: 1, currentLimitA: 16, ...singlePhaseRead(NOW) });
    f.owner.readPlanning(NOW);
    const target = switchDecision(3);
    if (target.kind === 'release') throw new Error('expected phase target');
    const preparation: ChargingPhaseDecision = { ...target, kind: 'prepare' };
    f.owner.reconcilePlan([preparation], NOW);
    await f.owner.apply(preparation, NOW + 1);
    f.setDevice({ currentLimitA: 6 });
    f.owner.reconcilePlan([], NOW + 1000);
    const withdrawn = f.owner.readPlanning(NOW + 1001);
    expect(withdrawn.candidates).toEqual([]);
    expect(withdrawn.releases).toEqual([]);
    expect(f.values.get(RECORD_KEY)).toMatchObject({ kind: 'free' });
    expect(f.owner.blocksIncrease(ID)).toBe(false);
    expect(f.owner.readPlanning(NOW + 1004).candidates).toEqual([]);
    expect(f.apply.mock.calls.some(([command]) => command.kind === 'charging_phase')).toBe(false);
  });

  it('drops a queued phase request before issuing it when a safety command supersedes it', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    let unblock: () => void = () => {};
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const prior = f.owner.runDeviceCommand(ID, () => gate);
    const phase = f.owner.apply(switchDecision(1), NOW + 1);
    f.owner.cancelForSafety(ID);
    const off = vi.fn().mockResolvedValue(undefined);
    const paused = f.owner.runDeviceCommand(ID, off);
    unblock();
    await Promise.all([prior, phase, paused]);
    expect(f.apply).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledOnce();
  });

  it('invalidates the live authority and ignores a stale completed phase request after safety cancellation', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    let commandAuthority: ChargingPhaseCommandAuthority = { isCurrent: () => false };
    let started: () => void = () => {};
    let complete: () => void = () => {};
    const entered = new Promise<void>((resolve) => { started = resolve; });
    f.apply.mockImplementationOnce((command) => new Promise((resolve) => {
      commandAuthority = command.authority;
      complete = () => resolve({ requested: true });
      started();
    }));
    const request = f.owner.apply(switchDecision(1), NOW + 1);
    await entered;
    expect(commandAuthority.isCurrent()).toBe(true);
    f.owner.cancelForSafety(ID);
    expect(commandAuthority.isCurrent()).toBe(false);
    complete();
    await request;
    expect(f.contest.commandSent).not.toHaveBeenCalled();
    const read = f.owner.readPlanning(NOW + 1000);
    expect(read.reservations[0]?.totalKw).toBe(4.14);
    expect(read.releases).toEqual([{ kind: 'release', deviceId: ID }]);
  });

  it('revokes the phase write if another current setting arrives while the safe-current request is awaited', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    let continueAfterCurrent: () => void = () => {};
    let currentWasSent: () => void = () => {};
    const currentStarted = new Promise<void>((resolve) => { currentWasSent = resolve; });
    const phaseWrite = vi.fn();
    f.apply.mockImplementationOnce(async (command) => {
      const current = new Promise<void>((resolve) => { continueAfterCurrent = resolve; });
      currentWasSent();
      await current;
      if (!command.authority.isCurrent()) return { requested: false };
      phaseWrite();
      return { requested: true };
    });
    const request = f.owner.apply(switchDecision(1), NOW + 1);
    await currentStarted;
    f.setDevice({ currentLimitA: 16 });
    continueAfterCurrent();
    await request;
    expect(phaseWrite).not.toHaveBeenCalled();
    expect(f.owner.blocksIncrease(ID)).toBe(true);
    expect(f.owner.readPlanning(NOW + 1000).releases).toEqual([{ kind: 'release', deviceId: ID }]);
  });

  it('keeps a converged claim across ordinary plans and later current reductions', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    const decision = switchDecision(1);
    f.owner.reconcilePlan([decision], NOW);
    await f.owner.apply(decision, NOW + 1);
    f.setDevice({ forceSinglePhase: true, ...singlePhaseRead(NOW + 1000) });
    f.owner.readPlanning(NOW + 1001);
    f.owner.reconcilePlan([], NOW + 1002);
    expect(f.owner.readPlanning(NOW + 1003).releases).toEqual([]);
    expect(f.values.get(RECORD_KEY)).toMatchObject({ kind: 'held', originalForceSingle: false });
    f.owner.cancelForSafety(ID);
    expect(f.owner.blocksIncrease(ID)).toBe(false);
    expect(f.owner.readPlanning(NOW + 2000).releases).toEqual([]);
    expect(f.owner.getDesiredForceSingle(ID)).toBe(true);
  });

  it('does not release the increase fence during the build that resets a handed-back profile', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.setDevice({ forceSinglePhase: true, ...singlePhaseRead(NOW + 1000) });
    f.owner.readPlanning(NOW + 1001);
    f.setSimulation(true);
    const leaving = f.owner.readPlanning(NOW + 2000);
    await f.owner.apply(leaving.releases[0], NOW + 2001);
    f.setDevice({ forceSinglePhase: false, totalPower: { watts: 0, observedAtMs: NOW + 3000 } });
    f.owner.readPlanning(NOW + 3001);
    expect(f.source.releasePlanningEnvelope).toHaveBeenCalledWith(ID, false);
    expect(f.owner.blocksIncrease(ID)).toBe(true);
    f.owner.readPlanning(NOW + 3002);
    expect(f.owner.blocksIncrease(ID)).toBe(false);
  });

  it('keeps Main phase work intact when a meter area executes its empty phase axis', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    const decision = switchDecision(1);
    f.owner.reconcilePlan([decision], NOW);
    await f.owner.apply(decision, NOW + 1);
    const area = new ExecutionOnlyChargingPhases(f.owner);
    await new ChargingPhaseExecutor(area).apply([], NOW + 1000);
    expect(area.readPlanning(NOW + 1001).candidates).toEqual([]);
    expect(area.getDesiredForceSingle(ID)).toBeNull();
    expect(area.blocksIncrease(ID)).toBe(true);
    expect(f.owner.readPlanning(NOW + 1002).releases).toEqual([]);
    expect(f.owner.readPlanning(NOW + 1003).continuations).toEqual([decision]);
  });

  it('lets area safety cancel a paused hand-back and retain its recovery obligation', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.setDevice({ forceSinglePhase: true, ...singlePhaseRead(NOW + 1000) });
    f.owner.readPlanning(NOW + 1001);
    f.setDevice({ controlEnabled: false });
    const leaving = f.owner.readPlanning(NOW + 2000);
    const area = new ExecutionOnlyChargingPhases(f.owner);
    let resume: () => void = () => {};
    let started: () => void = () => {};
    const paused = new Promise<void>((resolve) => { started = resolve; });
    const restorePhase = vi.fn();
    f.apply.mockImplementationOnce(async (command) => {
      if (command.kind !== 'charging_phase_release') throw new Error('expected release');
      command.pauseLifecycle.onStarting(NOW + 2001);
      command.pauseLifecycle.onAccepted();
      started();
      await new Promise<void>((resolve) => { resume = resolve; });
      if (!command.authority.isCurrent()) return { requested: false };
      restorePhase();
      return { requested: true };
    });
    const release = f.owner.apply(leaving.releases[0], NOW + 2001);
    await paused;
    area.cancelForSafety(ID);
    const off = vi.fn().mockResolvedValue(undefined);
    const safety = area.runDeviceCommand(ID, off);
    resume();
    await Promise.all([release, safety]);
    expect(off).toHaveBeenCalledOnce();
    expect(restorePhase).not.toHaveBeenCalled();
    expect(area.blocksIncrease(ID)).toBe(true);
    expect(f.values.get(RECORD_KEY)).toMatchObject({ kind: 'held', originalForceSingle: false });
    expect(f.owner.readPlanning(NOW + 3000).releases).toEqual([{ kind: 'release', deviceId: ID }]);
  });

  it('shares the durable startup fence with an area before Main has built a plan', async () => {
    const f = fixture();
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    const rebooted = f.create();
    const area = new ExecutionOnlyChargingPhases(rebooted);
    expect(area.read(ID)).toMatchObject({ kind: 'supported', status: { kind: 'releasing' } });
    expect(area.blocksIncrease(ID)).toBe(true);
  });


  it('enforces single permission for a car already drawing one phase without waiting for changed watts', async () => {
    const f = fixture();
    f.setDevice({ ...singlePhaseRead(NOW - 1000), planningPhases: 3, forceSinglePhase: false });
    expect(f.owner.readPlanning(NOW).candidates[0]?.forceSinglePhase).toBe(false);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.setDevice({ forceSinglePhase: true, planningPhases: 1 });
    expect(f.owner.readPlanning(NOW + 1000).reservations[0]?.totalKw).toBe(0);
    expect(f.owner.blocksIncrease(ID)).toBe(false);
    expect(f.values.get(RECORD_KEY)).toMatchObject({ kind: 'held', originalForceSingle: false });
  });

  it('requires new drawing evidence when a single-phase request was issued while idle', async () => {
    const f = fixture();
    f.setDevice({ drawingPhases: undefined, totalPower: { watts: 0, observedAtMs: NOW - 1000 },
      powers: [{ watts: 0, observedAtMs: NOW - 1000 }, { watts: 0, observedAtMs: NOW - 1000 },
        { watts: 0, observedAtMs: NOW - 1000 }] });
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(1), NOW + 1);
    f.setDevice({ forceSinglePhase: true, planningPhases: 1 });
    expect(f.owner.readPlanning(NOW + 1000).reservations[0]?.totalKw).toBe(4.14);
    expect(f.owner.blocksIncrease(ID)).toBe(true);
  });

  it('does not complete a three-phase request from its setting echo and retained single-phase draw', async () => {
    const f = fixture();
    f.values.set(CHARGING_PHASE_SETTINGS_KEY, { [ID]: { mode: 'three', installationConfirmed: true } });
    f.setDevice({ forceSinglePhase: true, ...singlePhaseRead(NOW - 1000) });
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(3), NOW + 1);
    f.setDevice({ forceSinglePhase: false, planningPhases: 3 });
    expect(f.owner.readPlanning(NOW + 1000).reservations[0]?.totalKw).toBe(4.14);
    expect(f.owner.blocksIncrease(ID)).toBe(true);
  });

  it.each([1, 3] as const)('does not issue an idle command when %i-phase permission already matches', async (phases) => {
    const f = fixture();
    f.values.set(CHARGING_PHASE_SETTINGS_KEY,
      { [ID]: { mode: phases === 1 ? 'single' : 'three', installationConfirmed: true } });
    f.setDevice({ forceSinglePhase: phases === 1, drawingPhases: undefined,
      totalPower: { watts: 0, observedAtMs: NOW }, powers: [
        { watts: 0, observedAtMs: NOW }, { watts: 0, observedAtMs: NOW }, { watts: 0, observedAtMs: NOW }] });
    f.owner.readPlanning(NOW);
    await f.owner.apply(switchDecision(phases), NOW + 1);
    f.owner.readPlanning(NOW + CHARGING_PHASE_CONFIRMATION_MS + 2);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.owner.blocksIncrease(ID)).toBe(false);
  });

});
