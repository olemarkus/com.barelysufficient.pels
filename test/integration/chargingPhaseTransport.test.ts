import { ChargingPhaseTransport } from '../../lib/device/chargingPhaseTransport';
import { TransportSnapshotStore } from '../../lib/device/transport/transportSnapshotStore';
import type { HomeyActionAccess } from '../../lib/device/transport/homeyActionAccess';
import type { DevicePhaseConnection }
  from '../../packages/shared-domain/src/settings/devicePhaseConnections';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { partialDouble } from '../helpers/partialDouble';

const { readCards } = vi.hoisted(() => ({ readCards: vi.fn() }));
vi.mock('../../lib/device/transport/managerHomeyApi', () => ({ getRawFromHomeyApi: readCards }));

const authority = { isCurrent: () => true };
const pauseLifecycle = { onStarting: vi.fn(), onAccepted: vi.fn(), onFailed: vi.fn() };
const stamp = 1_800_000_000_000;
const cap = <T>(value: T, observedAtMs = stamp) => ({ value, lastUpdated: observedAtMs });
function charger(): HomeyDeviceLike {
  const capabilitiesObj = {
    peblar_force_1_phase: cap(false), peblar_charge_limit: { ...cap(16), min: 6, max: 16, setable: true },
    measure_power: cap(11040), peblar_power_l1: cap(3680), peblar_power_l2: cap(3680), peblar_power_l3: cap(3680),
    evcharger_charging_state: cap('plugged_in_charging'),
  };
  return { ...HOMEY_DEVICE_FIELDS, id: 'charger', name: 'Charger', class: 'evcharger',
    driverId: 'homey:app:com.KyleMichiels.Peblar:peblar_charger',
    capabilities: Object.keys(capabilitiesObj), capabilitiesObj };
}

function harness(
  preset: 'ev_charger_1_phase' | 'ev_charger_3_phase' = 'ev_charger_3_phase',
  connection: DevicePhaseConnection | null = 'three_L2',
) {
  const raw = charger();
  const snapshots = new TransportSnapshotStore();
  snapshots.trackRawDevice(raw.id, raw);
  let optedIn = true;
  const runAction = vi.fn<HomeyActionAccess['runAction']>(async () => undefined);
  const pause = vi.fn(async () => {
    raw.capabilitiesObj.peblar_charge_limit = { ...raw.capabilitiesObj.peblar_charge_limit, ...cap(0) };
  });
  const write = vi.fn(async () => undefined);
  const transport = new ChargingPhaseTransport(snapshots, {
    getDeviceChargingPhaseSettings: () => optedIn ? { mode: 'automatic', installationConfirmed: true } : undefined,
    getDeviceTargetPowerConfig: () => ({ enabled: true, preset }),
    getDevicePhaseConnection: () => connection ?? undefined, isManaged: () => true, isControllable: () => true,
  }, partialDouble<HomeyActionAccess>({ runAction }), pause, () => ({ kind: 'unrestricted' }), write);
  readCards.mockResolvedValue([
    { id: 'homey:device:charger:set_force_1_phase' },
    { id: 'homey:device:charger:set_charge_limit_with_phase' },
  ]);
  return { raw, transport, pause, runAction, write, leaveToCharger: () => { optedIn = false; } };
}

describe('charging phase transport', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['all', 'L1', undefined] as const)('preserves legacy %s geometry without phase opt-in', (connection) => {
    const { raw, transport, leaveToCharger } = harness('ev_charger_1_phase', connection ?? null);
    leaveToCharger();
    expect(transport.profile(raw)).toBeUndefined();
  });

  it('restores conservative geometry from persisted installation metadata with no phase-control policy', () => {
    const { raw, transport, leaveToCharger } = harness('ev_charger_1_phase');
    leaveToCharger();
    raw.capabilitiesObj.measure_power = cap(3680);
    raw.capabilitiesObj.peblar_power_l2 = cap(0);
    raw.capabilitiesObj.peblar_power_l3 = cap(0);
    const profile = { steps: [{ id: 'off', planningPowerW: 0 },
      { id: '6a', planningCurrentA: 6, planningPowerW: 1380 }] };
    const snapshot = partialDouble<TransportDeviceSnapshot>({
      id: raw.id, automaticPowerControl: { mode: 'manual', profile }, reportedStepId: '6a',
      steppedLoadProfile: profile, targetPowerConfig: { enabled: true, preset: 'ev_charger_1_phase' },
    });
    const projected = transport.projectProfile(snapshot, raw);
    expect(projected.automaticPowerControl?.mode).toBe('manual');
    expect(projected.steppedLoadProfile?.steps.find((step) => step.id === '6a')?.planningPowerW).toBe(4140);
    expect(projected.reportedStepPowerW).toBe(4140);
    expect(projected.targetPowerConfig).toBeUndefined();
  });

  it('uses measured power instead of a phase setting echo, retaining the envelope through idle', () => {
    const { raw, transport, leaveToCharger } = harness();
    const firstStepW = () => transport.profile(raw)?.steps.find((step) => step.id === '6a')?.planningPowerW;
    expect(firstStepW()).toBe(4140);
    raw.capabilitiesObj.peblar_force_1_phase = cap(true, stamp + 1000);
    expect(firstStepW()).toBe(4140);
    raw.capabilitiesObj.measure_power = cap(3680, stamp + 2000);
    raw.capabilitiesObj.peblar_power_l1 = cap(3680, stamp + 2000);
    raw.capabilitiesObj.peblar_power_l2 = cap(0, stamp + 2000);
    raw.capabilitiesObj.peblar_power_l3 = cap(0, stamp + 2000);
    expect(firstStepW()).toBe(1380);
    raw.capabilitiesObj.measure_power = cap(0, stamp + 3000);
    raw.capabilitiesObj.peblar_power_l1 = cap(0, stamp + 3000);
    expect(firstStepW()).toBe(1380);
    leaveToCharger();
    expect(firstStepW()).toBe(1380);
  });

  it('keeps a conservative Manual profile after unrestricted hand-back with a saved one-phase preset', () => {
    const { raw, transport, leaveToCharger } = harness('ev_charger_1_phase');
    raw.capabilitiesObj.peblar_force_1_phase = cap(true);
    raw.capabilitiesObj.measure_power = cap(3680);
    raw.capabilitiesObj.peblar_power_l2 = cap(0);
    raw.capabilitiesObj.peblar_power_l3 = cap(0);
    expect(transport.profile(raw)?.steps.find((step) => step.id === '6a')?.planningPowerW).toBe(1380);
    leaveToCharger();
    transport.resetEnvelope(raw.id, false);
    raw.capabilitiesObj.peblar_force_1_phase = cap(false, stamp + 1000);
    const profile = transport.profile(raw)!;
    const snapshot = partialDouble<TransportDeviceSnapshot>({
      id: raw.id, automaticPowerControl: { mode: 'manual', profile }, reportedStepId: '6a',
      targetPowerConfig: { enabled: true, preset: 'ev_charger_1_phase' },
    });
    const projected = transport.projectProfile(snapshot, raw);
    expect(projected.steppedLoadProfile?.steps.find((step) => step.id === '6a')?.planningPowerW).toBe(4140);
    expect(projected.reportedStepPowerW).toBe(4140);
    expect(projected.targetPowerConfig).toBeUndefined();
    // Re-reading the unchanged pre-hand-back physical report cannot shrink the next start.
    expect(transport.profile(raw)?.steps.find((step) => step.id === '6a')?.planningPowerW).toBe(4140);
  });

  it('budgets three phases when unrestricted permission accompanies a car currently drawing on L1 only', () => {
    const { raw, transport } = harness();
    raw.capabilitiesObj.measure_power = cap(3680);
    raw.capabilitiesObj.peblar_power_l2 = cap(0);
    raw.capabilitiesObj.peblar_power_l3 = cap(0);
    expect(transport.profile(raw)?.steps.find((step) => step.id === '6a')?.planningPowerW).toBe(4140);
    const device = transport.readDevices()[0]!;
    expect(device.planningPhases).toBe(3);
    expect(device.drawingPhases).toBe(1);
    raw.capabilitiesObj.peblar_force_1_phase = cap(true, stamp + 1000);
    expect(transport.readDevices()[0]?.planningPhases).toBe(1);
    raw.capabilitiesObj.measure_power = cap(0, stamp + 2000);
    raw.capabilitiesObj.peblar_power_l1 = cap(0, stamp + 2000);
    expect(transport.readDevices()[0]?.drawingPhases).toBeUndefined();
    expect(transport.readDevices()[0]?.planningPhases).toBe(1);
  });

  it('keeps the configured three-phase model when no charging phase has ever been measured', () => {
    const { raw, transport } = harness();
    raw.capabilitiesObj.measure_power = cap(0);
    raw.capabilitiesObj.peblar_power_l1 = cap(0);
    raw.capabilitiesObj.peblar_power_l2 = cap(0);
    raw.capabilitiesObj.peblar_power_l3 = cap(0);
    raw.capabilitiesObj.peblar_force_1_phase = cap(true);
    expect(transport.profile(raw)?.steps.find((step) => step.id === '6a')?.planningPowerW).toBe(4140);
  });

  it('sends a coupled safe current and phase request without separate start/stop commands', async () => {
    const { transport, runAction, pause } = harness();
    await transport.request({ kind: 'charging_phase', authority, deviceId: 'charger', phases: 1, currentA: 6 });
    expect(pause).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith('charger', {
      ownerUri: 'homey:device:charger', cardId: 'homey:device:charger:set_charge_limit_with_phase',
      args: { amps: 6, phase_mode: '1f' },
    }, 'charging_phase', expect.any(Function));
  });

  it('uses writable native controls without requiring a Homey Flow API key', async () => {
    const { raw, transport, runAction, write } = harness();
    raw.capabilitiesObj.peblar_force_1_phase = { ...cap(false), setable: true };
    await transport.request({ kind: 'charging_phase', authority, deviceId: 'charger', phases: 1, currentA: 6 });
    expect(write.mock.calls).toEqual([
      ['charger', { capabilityId: 'peblar_charge_limit', value: 6 }],
      ['charger', { capabilityId: 'peblar_force_1_phase', value: true }],
    ]);
    expect(runAction).not.toHaveBeenCalled();
  });

  it('prepares current alone, without a phase-setting write', async () => {
    const { raw, transport, write, runAction } = harness();
    raw.capabilitiesObj.peblar_force_1_phase = { ...cap(false), setable: true };
    await transport.request({ kind: 'charging_phase_prepare', authority, deviceId: 'charger', currentA: 6 });
    expect(write.mock.calls).toEqual([['charger', { capabilityId: 'peblar_charge_limit', value: 6 }]]);
    expect(runAction).not.toHaveBeenCalled();
  });

  it('does not write a phase after safety invalidates authority while the current write is outstanding', async () => {
    const { raw, transport, write } = harness();
    raw.capabilitiesObj.peblar_force_1_phase = { ...cap(false), setable: true };
    let current = true;
    write.mockImplementationOnce(async () => { current = false; });
    expect(await transport.request({ kind: 'charging_phase', deviceId: 'charger', phases: 1, currentA: 6,
      authority: { isCurrent: () => current } })).toBe(false);
    expect(write.mock.calls).toEqual([['charger', { capabilityId: 'peblar_charge_limit', value: 6 }]]);
  });

  it('pauses before handing three-phase permission back at a high single-phase current', async () => {
    const { raw, transport, runAction, pause } = harness();
    raw.capabilitiesObj.peblar_force_1_phase = cap(true);
    await transport.request({ kind: 'charging_phase_release', authority, pauseLifecycle,
      deviceId: 'charger', forceSinglePhase: false });
    expect(pause).toHaveBeenCalledWith('charger');
    expect(pauseLifecycle.onStarting).toHaveBeenCalledWith(expect.any(Number));
    expect(pauseLifecycle.onAccepted).toHaveBeenCalledOnce();
    expect(pauseLifecycle.onFailed).not.toHaveBeenCalled();
    expect(pause.mock.invocationCallOrder[0]).toBeLessThan(runAction.mock.invocationCallOrder[0]!);
    expect(runAction.mock.calls[0]?.[1]).toMatchObject({ args: { enabled: false } });
  });

  it('does not record a nested pause when the current was already zero', async () => {
    const { raw, transport, pause } = harness();
    raw.capabilitiesObj.peblar_force_1_phase = cap(true);
    raw.capabilitiesObj.peblar_charge_limit = { ...raw.capabilitiesObj.peblar_charge_limit, ...cap(0) };
    expect(await transport.request({ kind: 'charging_phase_release', authority, pauseLifecycle,
      deviceId: raw.id, forceSinglePhase: false })).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    expect(pauseLifecycle.onStarting).not.toHaveBeenCalled();
    expect(pauseLifecycle.onAccepted).not.toHaveBeenCalled();
  });

  it('refuses phase expansion when another writer raises the current after the awaited pause', async () => {
    const { raw, transport, runAction, pause, write } = harness();
    raw.capabilitiesObj.peblar_force_1_phase = { ...cap(true), setable: true };
    pause.mockImplementationOnce(async () => {
      raw.capabilitiesObj.peblar_charge_limit = {
        ...raw.capabilitiesObj.peblar_charge_limit, ...cap(16, stamp + 1000),
      };
    });
    expect(await transport.request({ kind: 'charging_phase_release', authority, pauseLifecycle,
      deviceId: raw.id, forceSinglePhase: false })).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(pauseLifecycle.onAccepted).toHaveBeenCalledOnce();
    expect(pauseLifecycle.onFailed).not.toHaveBeenCalled();
  });

  it('keeps the original setting if the required hand-back pause fails', async () => {
    const { raw, transport, runAction, pause } = harness();
    raw.capabilitiesObj.peblar_force_1_phase = cap(true);
    pause.mockRejectedValueOnce(new Error('Pause limit reached'));
    await expect(transport.request({ kind: 'charging_phase_release', authority, pauseLifecycle,
      deviceId: 'charger', forceSinglePhase: false }))
      .rejects.toThrow('Pause limit reached');
    expect(runAction).not.toHaveBeenCalled();
    expect(pauseLifecycle.onAccepted).not.toHaveBeenCalled();
    expect(pauseLifecycle.onFailed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Pause limit reached' }));
  });
});
