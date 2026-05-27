import { applyShedReleaseIntent, type ShedReleaseActuationDeps } from '../lib/executor/shedReleaseActuation';
import type {
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
} from '../lib/executor/executablePlan';
import type { ShedAction } from '../lib/plan/planTypes';

vi.mock('../lib/executor/targetExecutor', () => ({
  applyTargetUpdate: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/executor/binaryExecutor', () => ({
  applyBinarySheddingToDevice: vi.fn().mockResolvedValue(true),
}));

import { applyTargetUpdate } from '../lib/executor/targetExecutor';
import { applyBinarySheddingToDevice } from '../lib/executor/binaryExecutor';

const mockedApplyTargetUpdate = applyTargetUpdate as unknown as ReturnType<typeof vi.fn>;
const mockedApplyBinarySheddingToDevice = applyBinarySheddingToDevice as unknown as ReturnType<typeof vi.fn>;

const buildIntent = (): ExecutableReleaseIntent => ({
  kind: 'shed_release',
  deviceId: 'dev-1',
  name: 'Device 1',
});

const buildObserved = (
  overrides?: Partial<ExecutableObservedDeviceState>,
): ExecutableObservedDeviceState => ({
  id: 'dev-1',
  name: 'Device 1',
  snapshot: { id: 'dev-1' } as never,
  available: true,
  currentOn: true,
  observedBinaryState: 'on',
  target: null,
  steppedLoad: null,
  ...overrides,
});

const buildDeps = (
  behavior: { action: ShedAction; temperature: number | null; stepId: string | null },
): ShedReleaseActuationDeps => ({
  getShedBehavior: () => behavior,
  buildBinaryExecutorContext: () => ({} as never),
  buildTargetExecutorContext: () => ({} as never),
});

describe('applyShedReleaseIntent', () => {
  beforeEach(() => {
    mockedApplyTargetUpdate.mockClear();
    mockedApplyBinarySheddingToDevice.mockClear();
  });

  it('returns false for an EV intent (this dispatch is for non-EV release only)', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: { kind: 'ev_pause', deviceId: 'dev-1', name: 'Device 1' },
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'onoff' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('fires a binary turn-off when shedBehavior is turn_off and the device is currently on', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'onoff' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplyBinarySheddingToDevice).toHaveBeenCalledTimes(1);
  });

  it('skips when the device is already observed off (idempotent)', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved({ currentOn: false }),
      snapshot: { id: 'dev-1', currentOn: false, controlCapabilityId: 'onoff' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('skips an EV-capability device routed through shed_release (defensive guard)', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'evcharger_charging' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('fires a target write at the shed temperature when shedBehavior is set_temperature', async () => {
    const deps = buildDeps({ action: 'set_temperature', temperature: 18, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved({
        target: { targetCap: 'target_temperature', observedValue: 22 },
      }),
      snapshot: { id: 'dev-1' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplyTargetUpdate).toHaveBeenCalledTimes(1);
    const [, command] = mockedApplyTargetUpdate.mock.calls[0];
    expect(command).toMatchObject({
      deviceId: 'dev-1',
      desired: 18,
      observedValue: 22,
      isRestoring: false,
    });
  });

  it('skips the temperature write when the observed target already equals the shed temperature', async () => {
    const deps = buildDeps({ action: 'set_temperature', temperature: 18, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved({
        target: { targetCap: 'target_temperature', observedValue: 18 },
      }),
      snapshot: { id: 'dev-1' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyTargetUpdate).not.toHaveBeenCalled();
  });

  it('routes set_step shedBehavior through the binary off path when the device has binary control', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'low' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'onoff' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplyBinarySheddingToDevice).toHaveBeenCalledTimes(1);
  });

  it('skips set_step shedBehavior on a device without binary control (known follow-up)', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'low' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('skips turn_off shedBehavior on a device without binary control', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });
});
