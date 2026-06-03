import {
  buildSwapState,
  cleanupCompletedSwaps,
  cleanupStaleSwaps,
  exportSwapState,
  isBlockedBySwapState,
  shouldDeferSwapAdmissionForMeasurement,
  shouldKeepSwapTargetPending,
  type SwapState,
} from '../lib/plan/swap';
import { isSwapTargetComplete } from '../lib/plan/swap/completion';
import { clearMissingSwapTarget } from '../lib/plan/swap/lifecycle';
import { SWAP_TIMEOUT_MS } from '../lib/plan/planConstants';
import { createPlanEngineState } from '../lib/plan/planState';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, steppedPlanDevice } from './utils/planTestUtils';

const emptySwapState = (): SwapState => buildSwapState(createPlanEngineState());

describe('swap lifecycle completion', () => {
  it('keeps a binary target pending until it is observed on', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');

    expect(isSwapTargetComplete(buildPlanDevice({ id: 'target', currentState: 'off', currentOn: false }), swapState))
      .toBe(false);
    expect(isSwapTargetComplete(buildPlanDevice({ id: 'target', currentState: 'on', currentOn: true }), swapState))
      .toBe(true);
  });

  it('keeps a stepped target pending while reported at a lower requested step', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'max' });

    const target = steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      currentOn: true,
      reportedStepId: 'medium',
    });

    expect(isSwapTargetComplete(target, swapState)).toBe(false);
  });

  it('clears a stepped target after the requested step is reported', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'medium' });

    const target = steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      currentOn: true,
      reportedStepId: 'max',
    });

    expect(isSwapTargetComplete(target, swapState)).toBe(true);
  });

  it('does not complete on optimistic selectedStepId ahead of the reported step', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'max' });

    // Planner-effective selectedStepId already reaches the requested step, but the device has
    // only confirmed a lower reportedStepId — completion must wait for confirmed evidence.
    const target = steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      currentOn: true,
      selectedStepId: 'max',
      reportedStepId: 'medium',
    });

    expect(isSwapTargetComplete(target, swapState)).toBe(false);
  });

  it('does not complete while reportedStepId is unknown even if selectedStepId reached the request', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'max' });

    const target = steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      currentOn: true,
      selectedStepId: 'max',
      reportedStepId: undefined,
    });

    expect(isSwapTargetComplete(target, swapState)).toBe(false);
  });

  it('does not clear a stepped pending target without a requested step', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');

    const target = steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      currentOn: true,
      reportedStepId: 'max',
      desiredStepId: undefined,
      targetStepId: undefined,
    });

    expect(isSwapTargetComplete(target, swapState)).toBe(false);
  });
});

describe('swap lifecycle blocking and cleanup', () => {
  it('keeps a directly swapped-out device blocked until the target is complete', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.swappedOutFor.set('lower', 'target');
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', name: 'Target', currentState: 'off', currentOn: false })],
      ['lower', buildPlanDevice({ id: 'lower', name: 'Lower', currentState: 'off', currentOn: false })],
    ]);

    expect(isBlockedBySwapState(deviceMap.get('lower')!, deviceMap, swapState)).toBe(true);
    expect(deviceMap.get('lower')?.reason).toMatchObject({ code: PLAN_REASON_CODES.swapPending });
  });

  it('blocks lower-priority restores behind an incomplete higher-priority target', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', name: 'Target', priority: 1, currentState: 'off', currentOn: false })],
      ['lower', buildPlanDevice({ id: 'lower', name: 'Lower', priority: 9, currentState: 'off', currentOn: false })],
    ]);

    expect(isBlockedBySwapState(deviceMap.get('lower')!, deviceMap, swapState)).toBe(true);
    expect(deviceMap.get('lower')?.reason).toMatchObject({ code: PLAN_REASON_CODES.swapPending });
  });

  it('stale cleanup clears target metadata and linked direct swaps but keeps measurement watermark', () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.pendingSwapTimestamps.set('target', now - SWAP_TIMEOUT_MS - 1);
    swapState.lastSwapPlanMeasurementTs.set('target', 123);
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'max' });
    swapState.swappedOutFor.set('lower', 'target');

    cleanupStaleSwaps(swapState, undefined);

    expect(exportSwapState(swapState).swapByDevice).toEqual({
      target: { lastPlanMeasurementTs: 123 },
    });
    expect(shouldDeferSwapAdmissionForMeasurement({
      swapState,
      deviceId: 'target',
      measurementTs: 123,
    })).toBe(true);
    expect(shouldDeferSwapAdmissionForMeasurement({
      swapState,
      deviceId: 'target',
      measurementTs: 124,
    })).toBe(false);
    vi.useRealTimers();
  });

  it('missing target cleanup is explicit and consistent', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.pendingSwapTimestamps.set('target', 1);
    swapState.lastSwapPlanMeasurementTs.set('target', 2);
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'low' });
    swapState.swappedOutFor.set('lower', 'target');

    clearMissingSwapTarget(swapState, 'target');

    expect(exportSwapState(swapState).swapByDevice).toEqual({});
  });

  it('completed cleanup clears target and linked direct swaps', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.pendingSwapTimestamps.set('target', 1);
    swapState.lastSwapPlanMeasurementTs.set('target', 123);
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'max' });
    swapState.swappedOutFor.set('lower', 'target');
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'on', currentOn: true })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', currentOn: false })],
    ]);

    cleanupCompletedSwaps(swapState, deviceMap);

    expect(exportSwapState(swapState).swapByDevice).toEqual({
      target: { lastPlanMeasurementTs: 123 },
    });
    expect(shouldDeferSwapAdmissionForMeasurement({
      swapState,
      deviceId: 'target',
      measurementTs: 123,
    })).toBe(true);
    expect(shouldDeferSwapAdmissionForMeasurement({
      swapState,
      deviceId: 'target',
      measurementTs: 124,
    })).toBe(false);
  });

  it('direct swapped-out cleanup preserves completed target measurement watermark', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.lastSwapPlanMeasurementTs.set('target', 123);
    swapState.swappedOutFor.set('lower', 'target');
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', name: 'Target', currentState: 'on', currentOn: true })],
      ['lower', buildPlanDevice({ id: 'lower', name: 'Lower', currentState: 'off', currentOn: false })],
    ]);

    expect(isBlockedBySwapState(deviceMap.get('lower')!, deviceMap, swapState)).toBe(false);

    expect(exportSwapState(swapState).swapByDevice).toEqual({
      target: { lastPlanMeasurementTs: 123 },
    });
  });

  it('completed cleanup clears a stepped target only after its requested step is reached', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.pendingSwapTimestamps.set('target', 1);
    swapState.lastSwapPlanMeasurementTs.set('target', 123);
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'medium' });
    swapState.swappedOutFor.set('lower', 'target');

    // First pass: target reports a lower step than requested — must stay pending. The optimistic
    // selectedStepId already reaches the request, but completion must wait for confirmed evidence.
    const belowRequestedMap = new Map([
      ['target', steppedPlanDevice({
        id: 'target',
        currentState: 'on',
        currentOn: true,
        selectedStepId: 'medium',
        reportedStepId: 'low',
      })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', currentOn: false })],
    ]);
    cleanupCompletedSwaps(swapState, belowRequestedMap);
    expect(exportSwapState(swapState).swapByDevice).toMatchObject({
      target: {
        pendingTarget: true,
        timestamp: 1,
        lastPlanMeasurementTs: 123,
        requestedTargetStepId: 'medium',
      },
      lower: { swappedOutFor: 'target' },
    });

    // Second pass: target now reports at or above the requested step — clear pending metadata and
    // the linked direct swap, but preserve the measurement watermark for orphan deferral.
    const atRequestedMap = new Map([
      ['target', steppedPlanDevice({
        id: 'target',
        currentState: 'on',
        currentOn: true,
        reportedStepId: 'medium',
      })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', currentOn: false })],
    ]);
    cleanupCompletedSwaps(swapState, atRequestedMap);
    expect(exportSwapState(swapState).swapByDevice).toEqual({
      target: { lastPlanMeasurementTs: 123 },
    });
  });

  it('does not release a swapped-out source while the target only optimistically selected the step', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.requestedTargetByDevice.set('target', { targetStepId: 'max' });
    swapState.swappedOutFor.set('lower', 'target');
    const deviceMap = new Map([
      ['target', steppedPlanDevice({
        id: 'target',
        name: 'Target',
        currentState: 'on',
        currentOn: true,
        selectedStepId: 'max',
        reportedStepId: 'low',
      })],
      ['lower', buildPlanDevice({ id: 'lower', name: 'Lower', currentState: 'off', currentOn: false })],
    ]);

    // The source must stay shed: the target has not confirmed the requested step yet.
    expect(isBlockedBySwapState(deviceMap.get('lower')!, deviceMap, swapState)).toBe(true);
    expect(deviceMap.get('lower')?.reason).toMatchObject({ code: PLAN_REASON_CODES.swapPending });
    cleanupCompletedSwaps(swapState, deviceMap);
    expect(exportSwapState(swapState).swapByDevice).toMatchObject({
      target: { pendingTarget: true },
      lower: { swappedOutFor: 'target' },
    });
  });
});

describe('swap measurement gating', () => {
  it('same measurement does not re-admit a pending swap target', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.lastSwapPlanMeasurementTs.set('target', 100);

    expect(shouldKeepSwapTargetPending({ swapState, deviceId: 'target', measurementTs: 100 })).toBe(true);
  });

  it('orphan measurement metadata does not mark a target swap pending', () => {
    const swapState = emptySwapState();
    swapState.lastSwapPlanMeasurementTs.set('target', 100);

    expect(shouldKeepSwapTargetPending({ swapState, deviceId: 'target', measurementTs: null })).toBe(false);
  });

  it('orphan measurement metadata still defers swap admission until a fresh measurement', () => {
    const swapState = emptySwapState();
    swapState.lastSwapPlanMeasurementTs.set('target', 100);

    expect(shouldDeferSwapAdmissionForMeasurement({
      swapState,
      deviceId: 'target',
      measurementTs: null,
    })).toBe(true);
    expect(shouldDeferSwapAdmissionForMeasurement({
      swapState,
      deviceId: 'target',
      measurementTs: 100,
    })).toBe(true);
    expect(shouldDeferSwapAdmissionForMeasurement({
      swapState,
      deviceId: 'target',
      measurementTs: 101,
    })).toBe(false);
  });

  it('missing measurement keeps a pending swap target conservative', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.lastSwapPlanMeasurementTs.set('target', 100);

    expect(shouldKeepSwapTargetPending({ swapState, deviceId: 'target', measurementTs: null })).toBe(true);
  });

  it('newer measurement allows admission re-evaluation', () => {
    const swapState = emptySwapState();
    swapState.pendingSwapTargets.add('target');
    swapState.lastSwapPlanMeasurementTs.set('target', 100);

    expect(shouldKeepSwapTargetPending({ swapState, deviceId: 'target', measurementTs: 101 })).toBe(false);
  });
});
