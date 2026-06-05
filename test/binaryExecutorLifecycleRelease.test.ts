import {
  applyBinarySheddingToDevice,
  applyDeferredEvCommand,
  type PlanExecutorBinaryContext,
} from '../lib/executor/binaryExecutor';
import { createPlanEngineState } from '../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../lib/observer/pendingBinaryCommands';
import { createDeviceActuator } from '../lib/actuator/deviceActuator';
import type { DeviceObservation } from '../lib/device/deviceObservation';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { ExecutableReleaseIntent } from '../lib/executor/executablePlan';

// Direct (non-flow-backed) marker-routing for the binary lifecycle-disable path.
// The flow-backed half is covered by a real-recorder assertion in planExecutor.test.ts
// (handleConfirmedBinaryCommand). Here the recorders mirror PlanExecutor's real ones:
// recordShedActuation stamps the capacity cooldown markers; recordReleaseShedActuation does
// not. So asserting which recorder fires also asserts the marker outcome.
const buildCtx = (snapshot: TargetDeviceSnapshot) => {
  const state = createPlanEngineState();
  const setCapabilityCalls: { capabilityId: string; value: boolean }[] = [];
  const observation = {
    getSnapshot: () => [snapshot],
    getSnapshotByDeviceId: (id: string) => (id === snapshot.id ? snapshot : undefined),
  } as unknown as DeviceObservation;

  // Mirror PlanExecutor.recordShedActuation: a capacity shed stamps both markers.
  const recordShedActuation = vi.fn((deviceId: string, _name: string, now: number) => {
    state.lastInstabilityMs = now;
    state.lastDeviceShedMs[deviceId] = now;
  });
  // Mirror PlanExecutor.recordReleaseShedActuation: diagnostic-only, no marker stamp.
  const recordReleaseShedActuation = vi.fn();

  const ctx: PlanExecutorBinaryContext = {
    state,
    observation,
    capacityDryRun: false,
    // Binary writes route through the actuator over a recording `setCapability`,
    // so the native-path assertions still observe the onoff/evcharger writes.
    buildBinaryControlTransport: () => ({
      observation,
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      actuator: createDeviceActuator({
        setCapability: async (_deviceId: string, capabilityId: string, value: unknown) => {
          setCapabilityCalls.push({ capabilityId, value: value as boolean });
          return undefined;
        },
        applyDeviceTargets: () => Promise.resolve(),
        triggerFlowBackedBinaryControl: () => Promise.reject(new Error('flow binary not expected in release test')),
      }),
    }),
    getRestoreLogSource: () => 'current_plan',
    recordShedActuation,
    recordReleaseShedActuation,
    recordRestoreActuation: () => {},
  };
  return { ctx, state, recordShedActuation, recordReleaseShedActuation, setCapabilityCalls };
};

const onoffSnapshot: TargetDeviceSnapshot = {
  id: 'dev-1',
  controlCapabilityId: 'onoff',
  capabilities: ['onoff'],
  canSetControl: true,
  binaryControl: { on: true },
  available: true,
} as unknown as TargetDeviceSnapshot;

const evSnapshot: TargetDeviceSnapshot = {
  id: 'ev-1',
  controlCapabilityId: 'evcharger_charging',
  capabilities: ['evcharger_charging'],
  canSetControl: true,
  binaryControl: { on: true },
  available: true,
  deviceClass: 'evcharger',
  evChargingState: 'plugged_in_charging',
} as unknown as TargetDeviceSnapshot;

describe('binary lifecycle-disable marker routing (direct paths)', () => {
  it('non-EV direct: lifecycleRelease alone records via the release recorder and leaves the markers clean', async () => {
    const h = buildCtx(onoffSnapshot);
    // Pass only lifecycleRelease — applyBinarySheddingToDevice derives skipPrecheck/trackPendingShed.
    const applied = await applyBinarySheddingToDevice(h.ctx, {
      deviceId: 'dev-1',
      deviceName: 'Heater',
      lifecycleRelease: true,
    });
    expect(applied).toBe(true);
    expect(h.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: false }]);
    expect(h.recordReleaseShedActuation).toHaveBeenCalledTimes(1);
    expect(h.recordShedActuation).not.toHaveBeenCalled();
    expect(h.state.lastInstabilityMs).toBeNull();
    expect(h.state.lastDeviceShedMs['dev-1']).toBeUndefined();
  });

  it('non-EV direct: a capacity shed (no lifecycleRelease) still stamps the markers', async () => {
    const h = buildCtx(onoffSnapshot);
    const applied = await applyBinarySheddingToDevice(h.ctx, {
      deviceId: 'dev-1',
      deviceName: 'Heater',
      skipPrecheck: true,
    });
    expect(applied).toBe(true);
    expect(h.recordShedActuation).toHaveBeenCalledTimes(1);
    expect(h.recordReleaseShedActuation).not.toHaveBeenCalled();
    expect(h.state.lastDeviceShedMs['dev-1']).toEqual(expect.any(Number));
  });

  it('EV ev_pause (lifecycle-end): records via the release recorder and leaves the markers clean', async () => {
    const h = buildCtx(evSnapshot);
    const intent: ExecutableReleaseIntent = { kind: 'ev_pause', deviceId: 'ev-1', name: 'Charger' };
    const applied = await applyDeferredEvCommand(h.ctx, intent, undefined, 'plan');
    expect(applied).toBe(true);
    expect(h.setCapabilityCalls).toEqual([{ capabilityId: 'evcharger_charging', value: false }]);
    expect(h.recordReleaseShedActuation).toHaveBeenCalledTimes(1);
    expect(h.recordShedActuation).not.toHaveBeenCalled();
    expect(h.state.lastInstabilityMs).toBeNull();
    expect(h.state.lastDeviceShedMs['ev-1']).toBeUndefined();
  });
});
