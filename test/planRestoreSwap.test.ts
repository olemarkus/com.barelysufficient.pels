import {
  buildInsufficientHeadroomUpdate,
  buildSwapCandidates,
  computeRestoreBufferKw,
  estimateRestorePower,
} from '../lib/plan/planRestoreSwap';
import type { DevicePlanDevice } from '../lib/plan/planTypes';

const baseDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice => ({
  id: 'dev',
  name: 'Device',
  currentState: 'on',
  plannedState: 'keep',
  currentTarget: null,
  plannedTarget: null,
  ...overrides,
});

describe('buildSwapCandidates', () => {
  it('stops when encountering lower priority devices', () => {
    const result = buildSwapCandidates({
      dev: baseDevice({ priority: 50 }),
      onDevices: [baseDevice({ id: 'low', name: 'Low', priority: 40, powerKw: 2 })],
      swappedOutFor: new Map(),
      availableHeadroom: 1,
      needed: 3,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(0);
  });

  it('skips ineligible devices and returns ready when enough headroom is found', () => {
    const swappedOutFor = new Map<string, string>([['skip', 'target']]);
    const restoredThisCycle = new Set(['restored']);
    const onDevices = [
      baseDevice({ id: 'shed', name: 'Shed', priority: 100, plannedState: 'shed', powerKw: 2 }),
      baseDevice({ id: 'skip', name: 'Skip', priority: 90, plannedState: 'keep', powerKw: 2 }),
      baseDevice({ id: 'restored', name: 'Restored', priority: 80, plannedState: 'keep', powerKw: 2 }),
      baseDevice({ id: 'add1', name: 'Add1', priority: 70, plannedState: 'keep', powerKw: 2 }),
      baseDevice({ id: 'add2', name: 'Add2', priority: 60, plannedState: 'keep' }),
    ];

    const result = buildSwapCandidates({
      dev: baseDevice({ priority: 50 }),
      onDevices,
      swappedOutFor,
      availableHeadroom: 0,
      needed: 3,
      restoredThisCycle,
    });

    expect(result.ready).toBe(true);
    expect(result.toShed.map((device) => device.id)).toEqual(['add1', 'add2']);
    expect(result.shedNames).toBe('Add1, Add2');
    expect(result.shedPower).toBe('3.00');
  });

  it('returns not ready when potential headroom is still insufficient', () => {
    const result = buildSwapCandidates({
      dev: baseDevice({ priority: 50 }),
      onDevices: [baseDevice({ id: 'on', name: 'On', priority: 90, powerKw: 1 })],
      swappedOutFor: new Map(),
      availableHeadroom: 0,
      needed: 5,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(1);
    expect(result.reason).toContain('insufficient headroom');
  });

  it('uses the same effective power estimate as shedding when evaluating swap candidates', () => {
    const result = buildSwapCandidates({
      dev: baseDevice({ priority: 50 }),
      onDevices: [
        baseDevice({
          id: 'candidate',
          name: 'Candidate',
          priority: 90,
          powerKw: 0.2,
          expectedPowerKw: 1.2,
        }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 0.2,
      needed: 1.3,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(true);
    expect(result.toShed.map((device) => device.id)).toEqual(['candidate']);
    expect(result.shedPowerByDeviceId.get('candidate')).toBeCloseTo(1.2, 6);
    expect(result.shedPower).toBe('1.20');
    expect(result.potentialHeadroom).toBeCloseTo(1.4, 6);
  });

  it('treats explicit zero expected or configured power as zero instead of falling back to 1kW', () => {
    const result = buildSwapCandidates({
      dev: baseDevice({ priority: 50 }),
      onDevices: [
        baseDevice({
          id: 'zero',
          name: 'Zero',
          priority: 90,
          expectedPowerKw: 0,
          powerKw: 0,
        }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 0.2,
      needed: 0.3,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(0);
    expect(result.shedPowerByDeviceId.size).toBe(0);
  });
});

describe('restore swap helpers', () => {
  it('returns a shed update when headroom is insufficient', () => {
    const update = buildInsufficientHeadroomUpdate(2, 1);
    expect(update.plannedState).toBe('shed');
    expect(update.reason).toContain('need 2.00kW');
  });

  it('estimates restore power from expected, measured, or fallback values', () => {
    expect(estimateRestorePower(baseDevice({ expectedPowerKw: 2, measuredPowerKw: 5, powerKw: 1 }))).toBe(2);
    expect(estimateRestorePower(baseDevice({ measuredPowerKw: 3, powerKw: 1 }))).toBe(3);
    expect(estimateRestorePower(baseDevice({ powerKw: 2 }))).toBe(2);
    expect(estimateRestorePower(baseDevice())).toBe(1);
  });

  it('uses lowest non-zero step for stepped devices at off-step', () => {
    const steppedProfile = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1250 },
        { id: 'mid', planningPowerW: 2000 },
        { id: 'max', planningPowerW: 3000 },
      ],
    };
    // At off-step: planningPowerKw=0, measuredPowerKw=0 — should use lowest non-zero step (1.25kW)
    expect(estimateRestorePower(baseDevice({
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'off',
      planningPowerKw: 0,
      measuredPowerKw: 0,
    }))).toBe(1.25);
    // At active step with positive planningPowerKw — should use planningPowerKw directly
    expect(estimateRestorePower(baseDevice({
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'mid',
      planningPowerKw: 2,
    }))).toBe(2);
    // No planningPowerKw set, no measuredPower — should still use lowest non-zero step
    expect(estimateRestorePower(baseDevice({
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'off',
    }))).toBe(1.25);
  });

  it('computes restore buffer with bounds and scaling', () => {
    expect(computeRestoreBufferKw(-2)).toBeCloseTo(0.2, 5);
    expect(computeRestoreBufferKw(0)).toBeCloseTo(0.2, 5);
    expect(computeRestoreBufferKw(1)).toBeCloseTo(0.2, 5);
    expect(computeRestoreBufferKw(1.5)).toBeCloseTo(0.25, 5);
    expect(computeRestoreBufferKw(3)).toBeCloseTo(0.4, 5);
    expect(computeRestoreBufferKw(5)).toBeCloseTo(0.6, 5);
    expect(computeRestoreBufferKw(10)).toBeCloseTo(0.6, 5);
  });
});
