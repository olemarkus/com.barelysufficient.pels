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
    deviceManager: { setCapability: vi.fn(), applyDeviceTargets: vi.fn() } as unknown as AppContext['deviceManager'],
    // Device temporarily absent from the live plan list (startup / snapshot flicker).
    planService: { getPlanDevices: () => [] } as unknown as AppContext['planService'],
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

    handleDeferredDeadlineReached(ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);

    // Still enabled — the task survives so a later tick can actuate once the
    // device reappears (regression: previously disarmed immediately, leaving the
    // device running with no diagnostic left to re-fire the release).
    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(true);
    expect(forgetDevice).not.toHaveBeenCalled();
  });

  it('gives up and disarms once the grace window has elapsed with the device still absent', () => {
    const { ctx, settingsStore, forgetDevice } = buildCtx();

    handleDeferredDeadlineReached(ctx, 'd1', 'temperature', DEADLINE, DEADLINE + GRACE_MS + 1);

    expect((settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(forgetDevice).toHaveBeenCalledWith('d1');
  });
});
