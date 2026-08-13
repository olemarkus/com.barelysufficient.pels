import {
  applyBinarySheddingToDevice,
  applyDeferredBinaryCommand,
  type PlanExecutorBinaryContext,
} from '../../lib/executor/binaryExecutor';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { DeviceObservation } from '../../lib/device/deviceObservation';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { ExecutableReleaseIntent } from '../../lib/executor/executablePlan';
import { createBinaryCommandClaim } from '../../lib/executor/binaryCommandClaim';

// Dispatch-level coverage for the binary lifecycle-disable path. Accounting is
// intentionally absent here: every binary transport remains pending until the
// PlanExecutor receives observer confirmation (covered in planExecutor.test.ts).
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
        resolveTemperatureTarget: (_deviceId, desired) => desired,
        requestSteppedLoadStep: async () => ({ requested: false }),
        requestBinaryControl: async (_deviceId: string, desired: boolean) => {
          setCapabilityCalls.push({ capabilityId: 'onoff', value: desired });
          return undefined;
        },
        requestTemperatureTarget: (_deviceId, desired) => Promise.resolve(desired),
      }),
    }),
    getRestoreLogSource: () => 'current_plan',
    recordShedActuation,
    recordReleaseShedActuation,
    recordRestoreActuation: () => {},
    binaryCommandClaim: createBinaryCommandClaim(),
    binaryCommandOwner: 'ordinary',
  };
  return { ctx, state, recordShedActuation, recordReleaseShedActuation, setCapabilityCalls };
};

const onoffSnapshot: TargetDeviceSnapshot = {
  id: 'dev-1',
  binaryCapabilityId: 'onoff',
  capabilities: ['onoff'],
  canSetControl: true,
  binaryControl: { on: true },
  available: true,
} as unknown as TargetDeviceSnapshot;

const evSnapshot: TargetDeviceSnapshot = {
  id: 'ev-1',
  binaryCapabilityId: 'evcharger_charging',
  capabilities: ['evcharger_charging'],
  canSetControl: true,
  binaryControl: { on: true },
  available: true,
  deviceClass: 'evcharger',
  evChargingState: 'plugged_in_charging',
} as unknown as TargetDeviceSnapshot;

describe('binary lifecycle-disable marker routing (direct paths)', () => {
  it('non-EV direct: lifecycleRelease stays pending without accounting at SDK acceptance', async () => {
    const h = buildCtx(onoffSnapshot);
    // Pass only lifecycleRelease — applyBinarySheddingToDevice derives skipPrecheck/trackPendingShed.
    const applied = await applyBinarySheddingToDevice(h.ctx, {
      deviceId: 'dev-1',
      deviceName: 'Heater',
      lifecycleRelease: true,
    });
    expect(applied).toBe(true);
    expect(h.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: false }]);
    expect(h.recordReleaseShedActuation).not.toHaveBeenCalled();
    expect(h.recordShedActuation).not.toHaveBeenCalled();
    expect(h.state.pendingBinaryCommands['dev-1']).toMatchObject({ desired: false, lifecycleRelease: true });
    expect(h.state.lastInstabilityMs).toBeNull();
    expect(h.state.lastDeviceShedMs['dev-1']).toBeUndefined();
  });

  it('non-EV direct: a capacity shed stays pending without accounting at SDK acceptance', async () => {
    const h = buildCtx(onoffSnapshot);
    const applied = await applyBinarySheddingToDevice(h.ctx, {
      deviceId: 'dev-1',
      deviceName: 'Heater',
      skipPrecheck: true,
    });
    expect(applied).toBe(true);
    expect(h.recordShedActuation).not.toHaveBeenCalled();
    expect(h.recordReleaseShedActuation).not.toHaveBeenCalled();
    expect(h.state.lastDeviceShedMs['dev-1']).toBeUndefined();
    expect(h.state.pendingBinaryCommands['dev-1']).toMatchObject({ desired: false });
  });

  it('binary_release uses the same semantic binary path for a charger', async () => {
    const h = buildCtx(evSnapshot);
    const intent: ExecutableReleaseIntent = { kind: 'binary_release', deviceId: 'ev-1', name: 'Charger' };
    const applied = await applyDeferredBinaryCommand(h.ctx, intent, undefined);
    expect(applied).toBe(true);
    expect(h.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: false }]);
    expect(h.recordReleaseShedActuation).not.toHaveBeenCalled();
    expect(h.recordShedActuation).not.toHaveBeenCalled();
    expect(h.state.pendingBinaryCommands['ev-1']).toMatchObject({ desired: false, lifecycleRelease: true });
    expect(h.state.lastInstabilityMs).toBeNull();
    expect(h.state.lastDeviceShedMs['ev-1']).toBeUndefined();
  });

  it('lifecycle release bypasses capacity dry-run while an ordinary capacity shed still honors it', async () => {
    const lifecycle = buildCtx(onoffSnapshot);
    lifecycle.ctx.capacityDryRun = true;
    expect(await applyBinarySheddingToDevice(lifecycle.ctx, {
      deviceId: 'dev-1',
      deviceName: 'Heater',
      lifecycleRelease: true,
    })).toBe(true);
    expect(lifecycle.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: false }]);

    const ordinary = buildCtx(onoffSnapshot);
    ordinary.ctx.capacityDryRun = true;
    expect(await applyBinarySheddingToDevice(ordinary.ctx, {
      deviceId: 'dev-1',
      deviceName: 'Heater',
      skipPrecheck: true,
    })).toBe(false);
    expect(ordinary.setCapabilityCalls).toEqual([]);
  });
});
