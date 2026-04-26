import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../packages/shared-domain/src/planStateLabels';
import { buildComparablePlanReason } from '../packages/shared-domain/src/planReasonSemantics';

const baseDevice = {
  reason: buildComparablePlanReason('keep'),
  controllable: true,
  available: true,
  plannedState: 'keep',
};

describe('planStateLabels', () => {
  it('keeps explicit shed plans held when current state is missing', () => {
    expect(resolvePlanStateKind({
      ...baseDevice,
      plannedState: 'shed',
    })).toBe('held');
  });

  it('classifies missing or empty current state as unknown after explicit plan states', () => {
    expect(resolvePlanStateKind(baseDevice)).toBe('unknown');
    expect(resolvePlanStateKind({
      ...baseDevice,
      currentState: '   ',
    })).toBe('unknown');
    expect(resolvePlanStateTone(baseDevice)).toBe('neutral');
  });

  it('uses idle as the default for enabled off devices', () => {
    expect(resolvePlanStateKind({
      ...baseDevice,
      currentState: 'off',
    })).toBe('idle');
  });

  it('keeps explicit restore-pending states resuming', () => {
    expect(resolvePlanStateKind({
      ...baseDevice,
      currentState: 'off',
      binaryCommandPending: true,
    })).toBe('resuming');
    expect(resolvePlanStateKind({
      ...baseDevice,
      controlModel: 'stepped_load',
      currentState: 'off',
      selectedStepId: 'eco',
      desiredStepId: 'comfort',
    })).toBe('resuming');
  });
});
