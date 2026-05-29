import { applyShedReleaseIntent, type ShedReleaseActuationDeps } from '../lib/executor/shedReleaseActuation';
import type {
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadIntent,
} from '../lib/executor/executablePlan';
import type { ShedAction } from '../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../packages/contracts/src/types';

vi.mock('../lib/executor/targetExecutor', () => ({
  applyTargetUpdate: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/executor/binaryExecutor', () => ({
  applyBinarySheddingToDevice: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/executor/steppedLoadExecutor', () => ({
  applySteppedLoadCommand: vi.fn().mockResolvedValue(true),
}));

import { applyTargetUpdate } from '../lib/executor/targetExecutor';
import { applyBinarySheddingToDevice } from '../lib/executor/binaryExecutor';
import { applySteppedLoadCommand } from '../lib/executor/steppedLoadExecutor';

const mockedApplyTargetUpdate = applyTargetUpdate as unknown as ReturnType<typeof vi.fn>;
const mockedApplyBinarySheddingToDevice = applyBinarySheddingToDevice as unknown as ReturnType<typeof vi.fn>;
const mockedApplySteppedLoadCommand = applySteppedLoadCommand as unknown as ReturnType<typeof vi.fn>;

const buildIntent = (overrides?: Partial<ExecutableReleaseIntent>): ExecutableReleaseIntent => ({
  kind: 'shed_release',
  deviceId: 'dev-1',
  name: 'Device 1',
  ...overrides,
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

const buildSteppedLoadProfile = (): SteppedLoadProfile => ({
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 500 },
    { id: 'mid', planningPowerW: 1000 },
    { id: 'high', planningPowerW: 2000 },
  ],
} as never);

const buildSteppedLoadIntent = (
  overrides?: Partial<ExecutableSteppedLoadIntent>,
): ExecutableSteppedLoadIntent => ({
  id: 'dev-1',
  name: 'Device 1',
  purpose: 'keep',
  steppedLoadProfile: buildSteppedLoadProfile(),
  shedAction: 'set_step',
  desired: { on: true, stepId: 'high' },
  planningCurrentOn: true,
  planningCurrentStepId: 'high',
  transition: null,
  matchingRestoreAttempt: null,
  matchingCommandAttempt: null,
  stepCommandRetryCount: 0,
  ...overrides,
});

const buildDeps = (
  behavior: { action: ShedAction; temperature: number | null; stepId: string | null },
  overrides: Partial<ShedReleaseActuationDeps> = {},
): ShedReleaseActuationDeps => ({
  getShedBehavior: () => behavior,
  buildBinaryExecutorContext: () => ({} as never),
  buildTargetExecutorContext: () => ({} as never),
  buildSteppedExecutorContext: () => ({} as never),
  recordReleaseShedActuation: vi.fn(),
  ...overrides,
});

describe('applyShedReleaseIntent', () => {
  beforeEach(() => {
    mockedApplyTargetUpdate.mockClear();
    mockedApplyBinarySheddingToDevice.mockClear();
    mockedApplySteppedLoadCommand.mockClear();
  });

  it('returns false for an EV intent (this dispatch is for non-EV release only)', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: { kind: 'ev_pause', deviceId: 'dev-1', name: 'Device 1' },
      steppedLoadIntent: null,
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
      steppedLoadIntent: null,
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'onoff' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplyBinarySheddingToDevice).toHaveBeenCalledTimes(1);
  });

  it('skips the binary write when observedBinaryState is already "off" (trusted-evidence idempotent)', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: null,
      observed: buildObserved({ currentOn: false, observedBinaryState: 'off' }),
      snapshot: { id: 'dev-1', currentOn: false, controlCapabilityId: 'onoff' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('skips the binary write when observedBinaryState is "unknown" (no trusted observation yet)', async () => {
    // Mirrors the abandon-grace pattern in planExecutionDrift.ts: a defaulted/missing
    // observation must never trigger a write against a never-observed device.
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: null,
      observed: buildObserved({ observedBinaryState: 'unknown' }),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'onoff' } as never,
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
      steppedLoadIntent: null,
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'evcharger_charging' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('fires a target write at the shed temperature when shedBehavior is set_temperature', async () => {
    const recordReleaseShedActuation = vi.fn();
    const deps = buildDeps(
      { action: 'set_temperature', temperature: 18, stepId: null },
      { recordReleaseShedActuation },
    );
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: null,
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
    // Diagnostics fix: a release-shed target write must record a pels_shed event so the
    // diagnostics service registers the actuation.
    expect(recordReleaseShedActuation).toHaveBeenCalledWith('dev-1', 'Device 1', expect.any(Number));
  });

  it('does not record a pels_shed event when the temperature target is skipped (no double-record)', async () => {
    const recordReleaseShedActuation = vi.fn();
    const deps = buildDeps(
      { action: 'set_temperature', temperature: 18, stepId: null },
      { recordReleaseShedActuation },
    );
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: null,
      observed: buildObserved({
        target: { targetCap: 'target_temperature', observedValue: 18 },
      }),
      snapshot: { id: 'dev-1' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyTargetUpdate).not.toHaveBeenCalled();
    expect(recordReleaseShedActuation).not.toHaveBeenCalled();
  });

  it('does not record a pels_shed event in reconcile mode (release writes are plan-only)', async () => {
    const recordReleaseShedActuation = vi.fn();
    const deps = buildDeps(
      { action: 'set_temperature', temperature: 18, stepId: null },
      { recordReleaseShedActuation },
    );
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: null,
      observed: buildObserved({
        target: { targetCap: 'target_temperature', observedValue: 22 },
      }),
      snapshot: { id: 'dev-1' } as never,
      mode: 'reconcile',
      deps,
    });
    expect(result).toBe(true);
    expect(recordReleaseShedActuation).not.toHaveBeenCalled();
  });

  it('skips the temperature write when the observed target already equals the shed temperature', async () => {
    const deps = buildDeps({ action: 'set_temperature', temperature: 18, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: null,
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
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true, controlCapabilityId: 'onoff' } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplyBinarySheddingToDevice).toHaveBeenCalledTimes(1);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('fires a stepped-load command for set_step on a stepped-only device with no binary control', async () => {
    const recordReleaseShedActuation = vi.fn();
    const deps = buildDeps(
      { action: 'set_step', temperature: null, stepId: 'low' },
      { recordReleaseShedActuation },
    );
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent({ planningCurrentStepId: 'high' }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplySteppedLoadCommand).toHaveBeenCalledTimes(1);
    const [, action] = mockedApplySteppedLoadCommand.mock.calls[0];
    expect(action).toMatchObject({
      id: 'dev-1',
      purpose: 'shed',
      desired: { stepId: 'low', on: true },
    });
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
    // The synthesized release action carries `transition: null`; applySteppedLoadCommand
    // would not record `pels_shed` on its own, so the helper must record explicitly.
    expect(recordReleaseShedActuation).toHaveBeenCalledWith('dev-1', 'Device 1', expect.any(Number));
  });

  it('uses the producer-resolved step (lowest-active fallback) when the configured stepId is null', async () => {
    // The producer's release cascade picks `lowest-active` when no preferred stepId is
    // configured; the consumer just reads `intent.releaseShedStepId`. This test simulates that
    // producer-side resolution by passing the already-resolved id on the intent.
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent({ planningCurrentStepId: 'high' }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplySteppedLoadCommand).toHaveBeenCalledTimes(1);
    const [, action] = mockedApplySteppedLoadCommand.mock.calls[0];
    expect(action.desired.stepId).toBe('low');
  });

  it('skips the stepped re-projection when intent.releaseShedStepId is null (degenerate profile)', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: null }),
      steppedLoadIntent: buildSteppedLoadIntent({ planningCurrentStepId: 'high' }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips the stepped re-projection when the device is already at the shed step (idempotent)', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'low' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent({ planningCurrentStepId: 'low' }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'low' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips the stepped re-projection when the device is already below the shed step (never step up)', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'mid' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'mid' }),
      steppedLoadIntent: buildSteppedLoadIntent({ planningCurrentStepId: 'low' }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'low' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips turn_off shedBehavior on a device without binary control', async () => {
    const deps = buildDeps({ action: 'turn_off', temperature: null, stepId: null });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: null,
      observed: buildObserved(),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when no observed step id is present (trusted-evidence gate)', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'low' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent({ planningCurrentStepId: 'high' }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: undefined },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when the observed step id is not in the current profile (ambiguous state)', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'low' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent({ planningCurrentStepId: 'high' }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'phantom-step-id-from-old-profile' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when the planner has a step command awaiting confirmation', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'low' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: buildSteppedLoadIntent({
        planningCurrentStepId: 'high',
        matchingCommandAttempt: {
          status: 'awaiting_confirmation',
          requestedStepId: 'mid',
        } as never,
      }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when a step-command retry is scheduled', async () => {
    const deps = buildDeps({ action: 'set_step', temperature: null, stepId: 'low' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: buildSteppedLoadIntent({
        planningCurrentStepId: 'high',
        nextStepCommandRetryAtMs: Date.now() + 60_000,
      }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high' },
      }),
      snapshot: { id: 'dev-1', currentOn: true } as never,
      mode: 'plan',
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });
});
