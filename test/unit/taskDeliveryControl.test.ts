import {
  observeTaskNonDelivery, NON_DELIVERY_HOLD_MS, type TaskNonDeliveryState,
} from '../../lib/objectives/deferredObjectives/taskDeliveryState';
import { describe, expect, it } from 'vitest';
import { resolveTaskDeliveryControl } from '../../lib/plan/taskDeliveryControl';
import type { DeviceExecutionState } from '../../lib/planContract/deviceExecutionState';
import { buildPlanDevice, fixtureControlPosture, steppedProfile } from '../utils/planTestUtils';
const state = (overrides: Partial<DeviceExecutionState> = {}): DeviceExecutionState => ({
  available: true, physicalState: 'on', observedStepId: null,
  desiredBinary: 'on', desiredStepId: null, binaryProgress: 'settled',
  stepProgress: 'undriven', targetProgress: 'undriven', resumeExpected: false,
  steppedTransitionPending: false, externalOffHeld: false, ...overrides,
});
const device = () => buildPlanDevice({
  id: 'relay', name: 'Relay', currentState: 'on', plannedState: 'keep',
  control: fixtureControlPosture({ controllable: true }),
});
describe('delivery control uses live convergence, not a command as proof', () => {
  it('permits a settled on device', () => {
    expect(resolveTaskDeliveryControl(device(), state())).toEqual({ kind: 'permitted' });
  });
  it('does not attribute a planned capacity shed that has not taken effect', () => {
    const limited = { ...device(), reason: { code: 'capacity' as const } };
    expect(resolveTaskDeliveryControl(limited, state({ desiredBinary: 'off', binaryProgress: 'pending' }))).toEqual({ kind: 'pending' });
    expect(resolveTaskDeliveryControl(limited, state({ desiredBinary: 'off', binaryProgress: 'unmet' }))).toEqual({ kind: 'failed' });
  });
  it('records a confirmed capacity restriction', () => {
    expect(resolveTaskDeliveryControl({ ...device(), reason: { code: 'capacity' as const } },
      state({ physicalState: 'off', desiredBinary: 'off' }))).toEqual({ kind: 'restricted', cause: 'capacity_limited' });
  });
  it('recognizes a settled step limit even with the binary axis on', () => {
    expect(resolveTaskDeliveryControl({ ...device(), reason: { code: 'capacity' as const } },
      state({ observedStepId: 'low', desiredStepId: 'low', stepProgress: 'settled' })))
      .toEqual({ kind: 'restricted', cause: 'capacity_limited' });
  });
  it('does not infer permission without command authority', () => {
    expect(resolveTaskDeliveryControl({ ...device(), control: fixtureControlPosture({ controllable: false }) }, state()))
      .toEqual({ kind: 'uncontrolled' });
  });
});

const runningRestoreHoldCases = [
  { name: 'on/off device', device: device(),
    execution: state({ desiredBinary: null, binaryProgress: 'undriven' }) },
  { name: 'thermostat', device: buildPlanDevice({
    id: 'thermostat', currentState: 'on', currentTarget: 21, plannedTarget: 21, currentTemperature: 20.7,
    control: fixtureControlPosture({ controllable: true }),
  }), execution: state({ desiredBinary: null, binaryProgress: 'undriven', targetProgress: 'undriven' }) },
  { name: 'stepped device', device: buildPlanDevice({
    id: 'stepper', currentState: 'on', steppedLoadProfile: steppedProfile, selectedStepId: 'low', desiredStepId: 'low',
    control: fixtureControlPosture({ controllable: true }),
  }), execution: state({ observedStepId: 'low', desiredStepId: 'low', stepProgress: 'settled' }) },
];

describe('restore admission holds on devices already running', () => {
  it.each(runningRestoreHoldCases)('preserves the non-delivery hold for a kept $name', (running) => {
    let nonDelivery: TaskNonDeliveryState = { kind: 'none' };
    const minuteMs = 60_000;
    for (let elapsedMs = 0; elapsedMs <= NON_DELIVERY_HOLD_MS; elapsedMs += minuteMs) {
      const reason = elapsedMs % (3 * minuteMs) === 0 ? { code: 'keep' as const, detail: null }
        : { code: elapsedMs % (3 * minuteMs) === minuteMs ? 'meter_settling' as const : 'cooldown_restore' as const,
          remainingSec: 30 };
      // A normal keep drives its settled intent; admission holds suppress that
      // intent without turning off the observed device.
      const execution = reason.code === 'keep'
        ? { ...running.execution, desiredBinary: 'on' as const, binaryProgress: 'settled' as const }
        : running.execution;
      const control = resolveTaskDeliveryControl({ ...running.device, reason }, execution);
      expect(control.kind).toBe('permitted');
      if (control.kind === 'no_decision') throw new Error('Expected an existing kept decision');
      nonDelivery = observeTaskNonDelivery(nonDelivery,
        { obligation: 'claimed', control: control.kind, draw: 'not_drawing' }, elapsedMs);
    }
    expect(nonDelivery).toEqual({ kind: 'confirmed', sinceMs: 0 });
  });

  it('resets the hold for a genuine pending device command and preserves failed/unobserved axes', () => {
    const waiting = { ...device(), reason: { code: 'meter_settling' as const, remainingSec: 30 } };
    const pending = resolveTaskDeliveryControl(waiting, state({ binaryProgress: 'pending' }));
    expect(pending).toEqual({ kind: 'pending' });
    expect(observeTaskNonDelivery({ kind: 'watching', sinceMs: 0 },
      { obligation: 'claimed', control: 'pending', draw: 'not_drawing' }, NON_DELIVERY_HOLD_MS))
      .toEqual({ kind: 'none' });
    expect(resolveTaskDeliveryControl(waiting, state({ targetProgress: 'unmet' }))).toEqual({ kind: 'failed' });
    expect(resolveTaskDeliveryControl(waiting, state({ targetProgress: 'unobserved' }))).toEqual({ kind: 'pending' });
  });

  it('keeps actual priority/capacity ceilings and inactive or off devices out of the exception', () => {
    expect(resolveTaskDeliveryControl({ ...device(), reason: { code: 'reserved_for_start', targetName: 'EV' } }, state()))
      .toEqual({ kind: 'restricted', cause: 'priority_limited' });
    expect(resolveTaskDeliveryControl({ ...device(), reason: { code: 'capacity' } }, state()))
      .toEqual({ kind: 'restricted', cause: 'capacity_limited' });
    const hold = { ...device(), reason: { code: 'meter_settling' as const, remainingSec: 30 } };
    expect(resolveTaskDeliveryControl({ ...hold, plannedState: 'inactive' }, state())).toEqual({ kind: 'pending' });
    expect(resolveTaskDeliveryControl({ ...hold, plannedState: 'shed' }, state())).toEqual({ kind: 'pending' });
    expect(resolveTaskDeliveryControl(hold, state({ physicalState: 'off', desiredBinary: null, binaryProgress: 'undriven' })))
      .toEqual({ kind: 'pending' });
  });
});
