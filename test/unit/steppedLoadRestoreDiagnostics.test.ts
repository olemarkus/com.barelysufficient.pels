import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logSteppedLoadRestoreBinaryUndriven } from '../../lib/executor/steppedLoadRestoreDiagnostics';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import type { ExecutableSteppedLoadDevice } from '../../lib/executor/executablePlan';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

// Minimal ExecutableSteppedLoadDevice carrying only the fields the diagnostic
// reads. Cast at the fixture boundary; the helper touches nothing else.
const buildAction = (overrides: {
  currentOn?: boolean;
  desiredOn?: boolean;
  desiredStepId?: string;
  transition?: ExecutableSteppedLoadDevice['transition'];
} = {}): ExecutableSteppedLoadDevice => ({
  id: 'dev-1',
  name: 'Tank',
  purpose: 'keep',
  steppedLoadProfile: PROFILE,
  current: { on: overrides.currentOn ?? false, stepId: 'low', stepIsOffStep: false },
  // Preserve an absent `desiredOn` (undefined) so the suite exercises the real
  // incident shape: `desired.on` missing, logged as null.
  desired: { on: overrides.desiredOn, stepId: overrides.desiredStepId ?? 'low' },
  transition: overrides.transition ?? null,
} as unknown as ExecutableSteppedLoadDevice);

let capture: LoggerCapture;
beforeEach(() => { capture = captureLogger(); });
afterEach(() => { capture.restore(); });

describe('logSteppedLoadRestoreBinaryUndriven', () => {
  it('logs the deciding inputs when a kept device is off with a non-off desired step', () => {
    logSteppedLoadRestoreBinaryUndriven(
      buildAction({
        currentOn: false,
        desiredStepId: 'low',
        transition: { effectiveTransition: 'steady', binaryTarget: null } as ExecutableSteppedLoadDevice['transition'],
      }),
      'plan',
    );
    expect(capture.findEvent('stepped_load_restore_binary_undriven')).toMatchObject({
      reasonCode: 'desired_on_not_true',
      deviceId: 'dev-1',
      desiredOn: null,
      currentOn: false,
      desiredStepId: 'low',
      transition: 'steady',
      binaryTarget: null,
      mode: 'plan',
    });
  });

  it('does not log when the device is observed on', () => {
    logSteppedLoadRestoreBinaryUndriven(buildAction({ currentOn: true, desiredStepId: 'low' }), 'plan');
    expect(capture.findEvent('stepped_load_restore_binary_undriven')).toBeUndefined();
  });

  it('does not log when the desired step is the off step', () => {
    logSteppedLoadRestoreBinaryUndriven(buildAction({ currentOn: false, desiredStepId: 'off' }), 'plan');
    expect(capture.findEvent('stepped_load_restore_binary_undriven')).toBeUndefined();
  });
});
