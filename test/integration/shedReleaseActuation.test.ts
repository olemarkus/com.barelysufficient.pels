import { applyShedReleaseIntent, type ShedReleaseActuationDeps } from '../../lib/executor/shedReleaseActuation';
import type {
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadIntent,
} from '../../lib/executor/executablePlan';
import type { ShedBehavior } from '../../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

vi.mock('../../lib/executor/targetExecutor', () => ({
  applyTargetUpdate: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../lib/executor/binaryExecutor', () => ({
  applyBinarySheddingToDevice: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../lib/executor/steppedLoadExecutor', () => ({
  applySteppedLoadCommand: vi.fn().mockResolvedValue(true),
}));

import { applyTargetUpdate } from '../../lib/executor/targetExecutor';
import { applyBinarySheddingToDevice } from '../../lib/executor/binaryExecutor';
import { applySteppedLoadCommand } from '../../lib/executor/steppedLoadExecutor';

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
  binaryControl: { on: true },
  observedBinaryState: 'on',
  target: null,
  steppedLoad: null,
  ...overrides,
  commandableNow: overrides?.commandableNow ?? true,
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
  desired: { on: true, stepId: 'high' },
  transition: null,
  matchingRestoreAttempt: null,
  matchingCommandAttempt: null,
  stepCommandRetryCount: 0,
  ...overrides,
});

const buildDeps = (
  behavior: ShedBehavior,
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
    const deps = buildDeps({ action: 'turn_off' });
    const result = await applyShedReleaseIntent({
      intent: { kind: 'binary_release', deviceId: 'dev-1', name: 'Device 1' },
      steppedLoadIntent: undefined,
      observed: buildObserved(),
      snapshot: { id: 'dev-1', binaryControl: { on: true }, binaryCapabilityId: 'onoff' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('fires a binary turn-off when shedBehavior is turn_off and the device is currently on', async () => {
    const deps = buildDeps({ action: 'turn_off' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      observed: buildObserved(),
      snapshot: { id: 'dev-1', binaryControl: { on: true }, binaryCapabilityId: 'onoff' } as never,
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplyBinarySheddingToDevice).toHaveBeenCalledTimes(1);
  });

  it('dispatches the binary turn-off as a lifecycle release: off the capacity path, diagnostic-only', async () => {
    // The binary disable must carry lifecycleRelease so both the direct write and any
    // deferred flow-backed confirmation record via the diagnostic-only recorder (no
    // capacity cooldown markers), and skip the capacity throttle / pendingSheds path.
    const deps = buildDeps({ action: 'turn_off' });
    await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      observed: buildObserved(),
      snapshot: { id: 'dev-1', binaryControl: { on: true }, binaryCapabilityId: 'onoff' } as never,
      deps,
    });
    expect(mockedApplyBinarySheddingToDevice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deviceId: 'dev-1',
        deviceName: 'Device 1',
        lifecycleRelease: true,
      }),
    );
    // lifecycleRelease alone drives the off-the-capacity-path behavior: applyBinarySheddingToDevice
    // derives skipPrecheck/trackPendingShed from it (covered in binaryExecutorLifecycleRelease.test.ts).
  });

  it('skips the binary write when observedBinaryState is already "off" (trusted-evidence idempotent)', async () => {
    const deps = buildDeps({ action: 'turn_off' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      observed: buildObserved({ binaryControl: { on: false }, observedBinaryState: 'off' }),
      snapshot: { id: 'dev-1', binaryControl: { on: false }, binaryCapabilityId: 'onoff' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('skips the binary write when observedBinaryState is "unknown" (no trusted observation yet)', async () => {
    // Mirrors the abandon-grace pattern in planExecutionDrift.ts: a defaulted/missing
    // observation must never trigger a write against a never-observed device.
    const deps = buildDeps({ action: 'turn_off' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      // 'unknown' is an off-union sentinel for "no trusted observation yet".
      observed: buildObserved({ observedBinaryState: 'unknown' as ExecutableObservedDeviceState['observedBinaryState'] }),
      snapshot: { id: 'dev-1', binaryControl: { on: true }, binaryCapabilityId: 'onoff' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  // (Removed) the EV-routed-through-shed_release case asserted a defensive guard that has
  // been deleted: shed_release is only ever produced for non-EV (temperature) objectives, so
  // an EV device never reaches this path. See the objectiveKind↔device invariant in admission.ts.

  it('fires a target write at the shed temperature when shedBehavior is set_temperature', async () => {
    const recordReleaseShedActuation = vi.fn();
    const deps = buildDeps(
      { action: 'set_temperature', temperature: 18 },
      { recordReleaseShedActuation },
    );
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      observed: buildObserved({
        target: { target: 'temperature', observedValue: 22 },
      }),
      snapshot: { id: 'dev-1' } as never,
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
      { action: 'set_temperature', temperature: 18 },
      { recordReleaseShedActuation },
    );
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      observed: buildObserved({
        target: { target: 'temperature', observedValue: 18 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyTargetUpdate).not.toHaveBeenCalled();
    expect(recordReleaseShedActuation).not.toHaveBeenCalled();
  });

  it('skips the temperature write when the observed target already equals the shed temperature', async () => {
    const deps = buildDeps({ action: 'set_temperature', temperature: 18 });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      observed: buildObserved({
        target: { target: 'temperature', observedValue: 18 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyTargetUpdate).not.toHaveBeenCalled();
  });

  it('routes set_step shedBehavior through the binary off path when the device has binary control', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved(),
      snapshot: { id: 'dev-1', binaryControl: { on: true }, binaryCapabilityId: 'onoff' } as never,
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplyBinarySheddingToDevice).toHaveBeenCalledTimes(1);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  // Pins the disjointness that lets flow reports be admitted as observed evidence
  // while the binary axis reads off (2026-07-25). The admission only ever produces
  // a non-off observed step on a device that HAS a binary control — and this
  // dispatch is unreachable for those, so admitting the report cannot make PELS
  // command a step at a device it has deliberately turned off. If the
  // `!snapshot.binaryCapabilityId` routing above ever changes, that guarantee is
  // gone and the admission needs its own "does PELS want this device on?" gate.
  it('never dispatches a stepped release for a binary-capable device observed off at a non-off step', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      // The prod shape: PELS turned the charger off, and the flow then reported a
      // higher step (Easee reverting to 32 A) which is now observed truth.
      observed: buildObserved({
        binaryControl: { on: false },
        observedBinaryState: 'off',
        steppedLoad: { on: false, stepId: 'high', currentDrawKw: 0 },
      }),
      snapshot: {
        id: 'dev-1',
        binaryControl: { on: false },
        binaryCapabilityId: 'evcharger_charging',
      } as never,
      deps,
    });
    // Routed to the binary path (device has a control capability), which is
    // idempotent against an already-off device: nothing is written at all.
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
  });

  it('fires a stepped-load command for set_step on a stepped-only device with no binary control', async () => {
    const recordReleaseShedActuation = vi.fn();
    const deps = buildDeps(
      { action: 'set_step' },
      { recordReleaseShedActuation },
    );
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high', reportedStepId: 'high', currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
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
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high', reportedStepId: 'high', currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(true);
    expect(mockedApplySteppedLoadCommand).toHaveBeenCalledTimes(1);
    const [, action] = mockedApplySteppedLoadCommand.mock.calls[0];
    expect(action.desired.stepId).toBe('low');
  });

  it('skips the stepped re-projection when intent.releaseShedStepId is null (degenerate profile)', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: null }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high', currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips the stepped re-projection when the device is already at the shed step (idempotent)', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'low', reportedStepId: 'low', currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips the stepped re-projection when the device is already below the shed step (never step up)', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'mid' }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'low', reportedStepId: 'low', currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips turn_off shedBehavior on a device without binary control', async () => {
    const deps = buildDeps({ action: 'turn_off' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: undefined,
      observed: buildObserved(),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplyBinarySheddingToDevice).not.toHaveBeenCalled();
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when selected state exists but no reported step id is present', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high', reportedStepId: undefined, currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when the observed step id is not in the current profile (ambiguous state)', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent({ releaseShedStepId: 'low' }),
      steppedLoadIntent: buildSteppedLoadIntent(),
      observed: buildObserved({
        steppedLoad: {
          on: true,
          stepId: 'high',
          reportedStepId: 'phantom-step-id-from-old-profile',
          currentDrawKw: 0,
        },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when the planner has a step command awaiting confirmation', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: buildSteppedLoadIntent({
        matchingCommandAttempt: {
          status: 'awaiting_confirmation',
          requestedStepId: 'mid',
        } as never,
      }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high', currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });

  it('skips stepped release when a step-command retry is scheduled', async () => {
    const deps = buildDeps({ action: 'set_step' });
    const result = await applyShedReleaseIntent({
      intent: buildIntent(),
      steppedLoadIntent: buildSteppedLoadIntent({
        nextStepCommandRetryAtMs: Date.now() + 60_000,
      }),
      observed: buildObserved({
        steppedLoad: { on: true, stepId: 'high', currentDrawKw: 0 },
      }),
      snapshot: { id: 'dev-1' } as never,
      deps,
    });
    expect(result).toBe(false);
    expect(mockedApplySteppedLoadCommand).not.toHaveBeenCalled();
  });
});
