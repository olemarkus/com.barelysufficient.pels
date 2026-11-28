import { describe, expect, it } from 'vitest';
import type { DeviceControlAdapterSnapshot, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { resolveCurrentActionStep } from '../../lib/executor/currentActionStep';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';

const ACKNOWLEDGED_AT_MS = 1_000_000;
const profile: SteppedLoadProfile = { steps: [
  { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
  { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
  { id: '32a', planningPowerW: 7360, planningCurrentA: 32 },
] };
const control: DeviceControlAdapterSnapshot = {
  kind: 'capability_adapter', activationRequired: false, activationEnabled: true, currentActionEpoch: 3,
};
const command = {
  stepId: '6a', status: 'success' as const,
  currentActionReceipt: { epoch: 3, acknowledgedAtMs: ACKNOWLEDGED_AT_MS, planningPowerW: 1380 },
};
const drawAfter = (afterMs: number, measuredPowerKw: number) => ({
  measuredPowerKw, measuredPowerObservedAtMs: ACKNOWLEDGED_AT_MS + afterMs,
});

describe('current action step', () => {
  it('keeps the lowered step while the draw still follows the earlier current', () => {
    expect(resolveCurrentActionStep(command, control, profile, drawAfter(10_000, 7.2))).toBe('6a');
    expect(resolveCurrentActionStep(command, control, profile, drawAfter(CONTROL_COMMAND_CONFIRMATION_MS, 7.2)))
      .toBe('6a');
  });

  it('lets a draw above the step after the confirmation window contradict the write', () => {
    expect(resolveCurrentActionStep(command, control, profile, drawAfter(CONTROL_COMMAND_CONFIRMATION_MS + 1, 7.2)))
      .toBeUndefined();
    expect(resolveCurrentActionStep(command, control, profile, drawAfter(CONTROL_COMMAND_CONFIRMATION_MS + 1, 1.4)))
      .toBe('6a');
  });

  it('drops the receipt from another control session', () => {
    expect(resolveCurrentActionStep(command, { ...control, currentActionEpoch: 4 }, profile, undefined))
      .toBeUndefined();
  });
});
