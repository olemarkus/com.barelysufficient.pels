import { handleDeferredDeadlineReached } from '../../setup/appInit/deferredObjectiveLifecycle';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';

const DEADLINE = 1_000_000;
const GRACE_MS = 5 * 60 * 1000;

const buildCtx = () => {
  const settingsStore = new Map<string, unknown>([
    ['deferred_objective.d1', {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 21,
      deadlineAtMs: DEADLINE,
    }],
  ]);
  const forgetDevice = vi.fn();
  const clearForDevice = vi.fn();
  const homey = {
    flow: { getTriggerCard: vi.fn(), getConditionCard: vi.fn(), getActionCard: vi.fn() },
    settings: {
      get: vi.fn((key: string) => settingsStore.get(key)),
      set: vi.fn((key: string, value: unknown) => { settingsStore.set(key, value); }),
      unset: vi.fn((key: string) => { settingsStore.delete(key); }),
      getKeys: vi.fn(() => [...settingsStore.keys()]),
      on: vi.fn(),
      off: vi.fn(),
    },
  } as unknown as AppContext['homey'];
  const ctx = createAppContextMock({
    homey,
    isCapacityControlEnabled: () => false, // cap-off
    homeMembership: {
      getHomeIdForDevice: () => 'main',
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => false,
      isMainHomeActuationFenced: () => false,
      getConfiguredMeterSources: () => ({ state: 'resolved', deviceIds: new Set() }),
    } as unknown as AppContext['homeMembership'],
    deviceManager: { setCapability: vi.fn(), applyDeviceTargets: vi.fn() } as unknown as AppContext['deviceManager'],
    // Device temporarily absent from the descriptor/observer projections.
    deferredObjectiveStatusBus: { forgetDevice } as unknown as AppContext['deferredObjectiveStatusBus'],
    deferredObjectiveActivePlanRecorder: {
      clearForDevice,
      getActivePlansSnapshot: () => ({ version: 1, plansByDeviceId: {} }),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'],
  });
  return { ctx, settingsStore, forgetDevice };
};

describe('handleDeferredDeadlineReached — absent device must not disarm within grace', () => {
  it('does NOT disarm a cap-off task while its device is temporarily absent and within grace', () => {
    const { ctx, settingsStore, forgetDevice } = buildCtx();

    handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + 60_000);

    // Still enabled — the task survives so a later tick can actuate once the
    // device reappears (regression: previously disarmed immediately, leaving the
    // device running with no diagnostic left to re-fire the release).
    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(true);
    expect(forgetDevice).not.toHaveBeenCalled();
  });

  it('gives up and disarms once the grace window has elapsed with the device still absent', () => {
    const { ctx, settingsStore, forgetDevice } = buildCtx();

    handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + GRACE_MS + 1);

    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(forgetDevice).toHaveBeenCalledWith('d1');
  });
});

describe('handleDeferredDeadlineReached — unavailable device must not disarm within grace (commandability gate)', () => {
  // The descriptor is present but observer truth says `available === false`.
  // We can neither actuate nor trust an apparent-off, so the release keeps the
  // task armed and retries.
  const buildCtxWithUnavailableDevice = () => {
    const built = buildCtx();
    built.ctx.deviceControlHelpers.getLifecycleFallbackDevice = () => ({
      id: 'd1',
      name: 'EV charger',
      binaryAxis: {
        state: 'writable',
      },
      targetAxis: { state: 'unavailable' },
      stepAxis: { state: 'unavailable' },
    });
    built.ctx.getObservedState = () => ({
      id: 'd1',
      name: 'EV charger',
      available: false,
      binaryControl: { on: false },
      targets: [],
    });
    return built;
  };

  it('does NOT disarm while the device is unavailable and within grace', () => {
    const { ctx, settingsStore, forgetDevice } = buildCtxWithUnavailableDevice();

    handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + 60_000);

    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(true);
    expect(forgetDevice).not.toHaveBeenCalled();
  });

  it('gives up and disarms once grace has elapsed with the device still unavailable', () => {
    const { ctx, settingsStore, forgetDevice } = buildCtxWithUnavailableDevice();

    handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + GRACE_MS + 1);

    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(forgetDevice).toHaveBeenCalledWith('d1');
  });
});

describe('handleDeferredDeadlineReached — observer availability is authoritative', () => {
  it('ignores a contradictory stale unavailable plan projection', () => {
    const { ctx, settingsStore } = buildCtx();
    const getPlanDevices = vi.fn(() => [
      { id: 'd1', name: 'EV charger', available: false },
    ]);
    ctx.planService = { getPlanDevices } as unknown as AppContext['planService'];
    ctx.deviceControlHelpers.getLifecycleFallbackDevice = () => ({
      id: 'd1',
      name: 'EV charger',
      binaryAxis: {
        state: 'writable',
      },
      targetAxis: { state: 'unavailable' },
      stepAxis: { state: 'unavailable' },
    });
    ctx.getObservedState = () => ({
      id: 'd1',
      name: 'EV charger',
      available: true,
      binaryControl: { on: false },
      targets: [],
    });
    const converge = vi.fn(() => ({ settled: true }));
    ctx.lifecycleFallback = { converge, abandon: vi.fn() };

    handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + 60_000);

    expect(converge).toHaveBeenCalledTimes(1);
    expect(getPlanDevices).not.toHaveBeenCalled();
    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
  });
});

/**
 * A device with no commandable axis at all — a target-only thermostat whose
 * owner switched temperature control off has no target axis (the flag), no step
 * axis (the producer strips the ladder with the same flag) and no binary axis.
 * `getPlanDevices()` filters on MANAGED status, not axis presence, so such a
 * device legitimately reaches the terminal release.
 */
describe('handleDeferredDeadlineReached — undriveable device must not disarm within grace', () => {
  const buildCtxWithUndriveableDevice = () => {
    const built = buildCtx();
    built.ctx.deviceControlHelpers.getLifecycleFallbackDevice = () => ({
      id: 'd1',
      name: 'Thermostat',
      binaryAxis: { state: 'unavailable' },
      targetAxis: { state: 'unavailable' },
      stepAxis: { state: 'unavailable' },
    });
    built.ctx.getObservedState = () => ({
      id: 'd1',
      name: 'Thermostat',
      available: true,
      targets: [],
    }) as unknown as ReturnType<AppContext['getObservedState']>;
    return built;
  };

  it('does NOT disarm a task whose device has no writable axis while within grace', () => {
    const { ctx, settingsStore, forgetDevice } = buildCtxWithUndriveableDevice();

    handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + 60_000);

    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(true);
    expect(forgetDevice).not.toHaveBeenCalled();
  });

  it('gives up and disarms once the grace window has elapsed', () => {
    const { ctx, settingsStore, forgetDevice } = buildCtxWithUndriveableDevice();

    handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + GRACE_MS + 1);

    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(forgetDevice).toHaveBeenCalledWith('d1');
  });

  // The whole reason this is a result and not a throw: the caller loops over
  // every task's diagnostic with no per-device guard.
  it('returns rather than throwing, so the rest of the lifecycle tick still runs', () => {
    const { ctx } = buildCtxWithUndriveableDevice();

    expect(() => handleDeferredDeadlineReached(ctx, 'd1', DEADLINE, DEADLINE + 60_000)).not.toThrow();
  });
});
