import {
  PLAN_STATE_LABEL,
  PLAN_STATE_TONE,
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../packages/shared-domain/src/planStateLabels';
import type { DeviceOverviewSnapshot } from '../packages/shared-domain/src/deviceOverview';

const device = (overrides: Partial<DeviceOverviewSnapshot> = {}): DeviceOverviewSnapshot => ({
  currentState: 'on',
  plannedState: 'keep',
  ...overrides,
});

describe('resolvePlanStateKind', () => {
  it('returns "manual" when device is not controllable', () => {
    expect(resolvePlanStateKind(device({ controllable: false }))).toBe('manual');
  });

  it('returns "unavailable" when device is unavailable', () => {
    expect(resolvePlanStateKind(device({ available: false }))).toBe('unavailable');
  });

  it('returns "unknown" when observation is stale', () => {
    expect(resolvePlanStateKind(device({ observationStale: true }))).toBe('unknown');
  });

  it('returns "unknown" when current state is unknown', () => {
    expect(resolvePlanStateKind(device({ currentState: 'unknown' }))).toBe('unknown');
  });

  it('returns "idle" for planned inactive', () => {
    expect(resolvePlanStateKind(device({ plannedState: 'inactive', currentState: 'off' }))).toBe('idle');
  });

  it('returns "held" for planned shed', () => {
    expect(resolvePlanStateKind(device({ plannedState: 'shed', currentState: 'off' }))).toBe('held');
  });

  it('returns "resuming" when binary restore is pending', () => {
    expect(resolvePlanStateKind(device({
      plannedState: 'keep',
      currentState: 'off',
      binaryCommandPending: true,
    }))).toBe('resuming');
  });

  it('returns "resuming" when a stepped load has a pending step change from off', () => {
    expect(resolvePlanStateKind(device({
      controlModel: 'stepped_load',
      plannedState: 'keep',
      currentState: 'off',
      selectedStepId: 'low',
      desiredStepId: 'high',
    }))).toBe('resuming');
  });

  it('returns "active" when the device is on', () => {
    expect(resolvePlanStateKind(device({ plannedState: 'keep', currentState: 'on' }))).toBe('active');
  });

  it('returns "active" when state is not_applicable (temperature-managed)', () => {
    expect(resolvePlanStateKind(device({
      plannedState: 'keep',
      currentState: 'not_applicable',
    }))).toBe('active');
  });

  it('returns "resuming" as the fallback when no other rule fires', () => {
    expect(resolvePlanStateKind(device({
      plannedState: 'keep',
      currentState: 'off',
    }))).toBe('resuming');
  });
});

describe('label and tone maps', () => {
  it('maps every kind to a label and tone', () => {
    const kinds = ['active', 'idle', 'held', 'resuming', 'manual', 'unavailable', 'unknown'] as const;
    kinds.forEach((kind) => {
      expect(typeof PLAN_STATE_LABEL[kind]).toBe('string');
      expect(PLAN_STATE_LABEL[kind].length).toBeGreaterThan(0);
      expect(typeof PLAN_STATE_TONE[kind]).toBe('string');
    });
  });

  it('uses the new terminology on the user-facing labels', () => {
    expect(PLAN_STATE_LABEL.held).toBe('Limited');
    expect(PLAN_STATE_LABEL.resuming).toBe('Turning on');
    expect(PLAN_STATE_LABEL.idle).toBe('Off');
    expect(PLAN_STATE_LABEL.manual).toBe('Manual');
  });

  it('exposes a convenience resolver that chains kind → tone', () => {
    const sample = device({ plannedState: 'shed', currentState: 'off' });
    expect(resolvePlanStateTone(sample)).toBe('held');
  });
});
