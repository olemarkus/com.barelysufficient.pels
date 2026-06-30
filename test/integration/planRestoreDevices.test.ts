import {
  isBinaryRestoreCandidate,
  getEvRestoreStateBlockReason,
  getInactiveReason,
  getOffDevices,
  getOnDevices,
  getRestoreCandidates,
  isRestoreLiveEligibleDevice,
  isSteppedRestoreCandidate,
  isOffSteppedRestoreCandidate,
  getSteppedRestoreCandidates,
  markOffDevicesStayOff,
} from '../../lib/plan/restore/devices';
import type {
  DevicePlanDevice,
  TemperatureDiscriminantProbe,
  BinaryControlDiscriminantProbe,
  SteppedDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { buildPlanDevice } from '../utils/planTestUtils';
import { legacyDeviceReason, reasonText } from '../utils/deviceReasonTestUtils';

const makeDevice = (
  overrides: Partial<DevicePlanDevice>
    & TemperatureDiscriminantProbe
    & SteppedDiscriminantProbe
    & BinaryControlDiscriminantProbe
    & {
      reason?: DevicePlanDevice['reason'] | string;
      evChargingState?: string;
    },
): DevicePlanDevice => {
  const { binaryControl, ...rest } = overrides;
  const device = buildPlanDevice({
    // `makeDevice` defaults `currentState` to `'off'`; `buildPlanDevice` defaults
    // to `'on'`, so set it explicitly before the spread can override it.
    currentState: 'off',
    controlCapabilityId: 'onoff',
    ...rest,
  });
  if (binaryControl === undefined) return device;
  return withBinaryDiscriminant({ ...device, binaryControl }) as DevicePlanDevice;
};

describe('plan restore device helpers', () => {
  it('filters restore candidates and swap-out devices by priority and shed behavior', () => {
    const devices = [
      makeDevice({ id: 'low', priority: 1, currentState: 'off' }),
      makeDevice({ id: 'high', priority: 5, currentState: 'off' }),
      makeDevice({ id: 'on', priority: 10, currentState: 'on' }),
      makeDevice({ id: 'na', priority: 7, currentState: 'not_applicable' }),
      makeDevice({ id: 'temp-blocked', priority: 8, currentState: 'on', currentTarget: 21, plannedTarget: 21 }),
      makeDevice({ id: 'shed', currentState: 'off', plannedState: 'shed' }),
    ];

    expect(getOffDevices(devices).map((device) => device.id)).toEqual(['low', 'high']);
    expect(getOnDevices(devices, (deviceId) => (
      deviceId === 'temp-blocked'
        ? { action: 'set_temperature', temperature: 21, stepId: null }
        : { action: 'turn_off', temperature: null, stepId: null }
    )).map((device) => device.id)).toEqual(['on', 'na']);
    expect(getOnDevices(
      [makeDevice({ id: 'temp', currentState: 'on', currentTarget: 23, plannedTarget: 23 })],
      () => ({ action: 'set_temperature', temperature: 20, stepId: null }),
    ).map((device) => device.id)).toEqual(['temp']);
    expect(getOnDevices(
      [makeDevice({ id: 'temp', currentState: 'on', currentTarget: 20, plannedTarget: 20 })],
      () => ({ action: 'set_temperature', temperature: 20, stepId: null }),
    )).toEqual([]);
  });

  it('orders mixed binary and stepped restore candidates by priority', () => {
    const devices = [
      makeDevice({ id: 'binary-lower-priority', priority: 5, currentState: 'off' }),
      makeDevice({
        id: 'stepped-higher-priority',
        priority: 1,
        currentState: 'off',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'off',
      }),
      makeDevice({
        id: 'stepped-lower-priority',
        priority: 8,
        currentState: 'on',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
      }),
      makeDevice({ id: 'binary-higher-priority', priority: 2, currentState: 'off' }),
    ];

    expect(getRestoreCandidates(devices).map((candidate) => [candidate.kind, candidate.device.id])).toEqual([
      ['stepped', 'stepped-higher-priority'],
      ['binary', 'binary-higher-priority'],
      ['binary', 'binary-lower-priority'],
    ]);
  });

  // Behaviour change (resolved-control refactor): on/off is the latched `currentOn`
  // with no staleness gate (stale-off = trusted-off, stale-on = trusted-on), so
  // stale devices are classified by their last value rather than excluded.
  it('trusts stale observations (last value) when selecting restore and swap candidates', () => {
    const devices = [
      makeDevice({ id: 'fresh-off', priority: 1, currentState: 'off' }),
      makeDevice({ id: 'stale-off', priority: 2, currentState: 'off' }),
      makeDevice({
        id: 'fresh-step',
        priority: 3,
        currentState: 'on',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
      }),
      makeDevice({
        id: 'stale-step',
        priority: 4,
        currentState: 'on',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
      }),
      makeDevice({
        id: 'unknown-step-off',
        priority: 2,
        currentState: 'off',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: undefined,
      }),
      makeDevice({
        id: 'high-step-off',
        priority: 5,
        currentState: 'off',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
      }),
      makeDevice({
        id: 'unknown-step-on',
        priority: 3,
        currentState: 'on',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: undefined,
      }),
      makeDevice({
        id: 'no-binary-step',
        priority: 7,
        currentState: 'on',
        controlCapabilityId: undefined,
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
      }),
      makeDevice({ id: 'fresh-on', priority: 5, currentState: 'on' }),
      makeDevice({ id: 'stale-on', priority: 6, currentState: 'on' }),
    ];

    expect(getOffDevices(devices).map((device) => device.id)).toEqual(['fresh-off', 'stale-off']);
    // `no-binary-step` (a stepped device with no `controlCapabilityId`, e.g. a
    // target-power load) carries no binary `currentOn`, but on/off is still a real
    // question answered by the STEP axis: parked at an active, below-highest step it
    // is restore-eligible (step it up), exactly as the retired `isObservedOn` resolved
    // it. The step lanes drive these devices (`deviceActionProjection` → `set_step`),
    // so they must not silently drop out of restore after a cap.
    expect(getSteppedRestoreCandidates(devices).map((device) => device.id))
      .toEqual(['unknown-step-off', 'fresh-step', 'stale-step', 'high-step-off', 'no-binary-step']);
    // Stale-on / stale-step are now trusted-on (last value), so they join the swap-out set.
    expect(getOnDevices(devices, () => ({ action: 'turn_off', temperature: null, stepId: null }))
      .map((device) => device.id)).toEqual(['stale-on', 'fresh-on', 'stale-step', 'fresh-step', 'unknown-step-on']);
    expect(getOnDevices(devices, () => ({ action: 'set_step', temperature: null, stepId: 'low' }))
      .map((device) => device.id)).toEqual(['stale-on', 'fresh-on']);
  });

  it('classifies a step-only stepped device (no binary handle) for restore via the step axis', () => {
    // A target-power stepped load has no `controlCapabilityId`/`currentOn`, so its
    // restore eligibility comes from the STEP axis (mirrors the retired
    // `isObservedOff`/`isObservedOn`): off step ⇒ restore from off; active but
    // below-highest step ⇒ step up; highest step ⇒ nothing to restore. Without this
    // the device is capped via `set_step` and never stepped back up.
    const steppedProfile = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1250 },
        { id: 'max', planningPowerW: 3000 },
      ],
    };
    const stepOnly = (selectedStepId: string, currentState: string): DevicePlanDevice =>
      makeDevice({
        id: `step-only-${selectedStepId}`,
        priority: 1,
        controlCapabilityId: undefined,
        currentState,
        steppedLoadProfile: steppedProfile,
        selectedStepId,
      });

    const atOffStep = stepOnly('off', 'off');
    expect(isSteppedRestoreCandidate(atOffStep)).toBe(true);
    expect(isOffSteppedRestoreCandidate(atOffStep)).toBe(true);

    const atLowStep = stepOnly('low', 'on');
    expect(isSteppedRestoreCandidate(atLowStep)).toBe(true);
    expect(isOffSteppedRestoreCandidate(atLowStep)).toBe(false);

    const atMaxStep = stepOnly('max', 'on');
    expect(isSteppedRestoreCandidate(atMaxStep)).toBe(false);
    expect(isOffSteppedRestoreCandidate(atMaxStep)).toBe(false);
  });

  it('evaluates EV restore blocks and marks off devices as staying off', () => {
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
    }))).toBe('charger state unknown');
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    }))).toBe('charger is unplugged');
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
    }))).toBe('charger is not resumable');
    // EV identity follows isEvDevice (device class OR evcharger_charging capability):
    // an evcharger-class device controlling via a different capability still
    // surfaces the EV block reason instead of falling through as a generic binary.
    expect(getEvRestoreStateBlockReason(makeDevice({
      deviceClass: 'evcharger',
      controlCapabilityId: 'onoff',
      evChargingState: 'plugged_out',
    }))).toBe('charger is unplugged');
    // A genuine non-EV binary device is unaffected (no EV reason).
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'onoff',
      evChargingState: 'plugged_out',
    }))).toBeNull();
    expect(reasonText(getInactiveReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    })) ?? undefined)).toBe('inactive (charger is unplugged)');
    expect(getInactiveReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_paused',
      expectedPowerSource: 'default',
    }))).toBeNull();

    const deviceMap = new Map<string, DevicePlanDevice>([
      ['dev1', makeDevice({ id: 'dev1', name: 'Device 1', powerKw: 1.1 })],
      ['dev2', makeDevice({ id: 'dev2', name: 'Device 2', reason: legacyDeviceReason('shed due to capacity')!, powerKw: 2.2 })],
      ['ev1', makeDevice({
        id: 'ev1',
        name: 'EV 1',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_out',
        expectedPowerSource: 'load-setting',
      })],
    ]);
    const setDevice = vi.fn((id: string, updates: Partial<DevicePlanDevice>) => {
      const current = deviceMap.get(id);
      if (current) deviceMap.set(id, { ...current, ...updates });
    });
    markOffDevicesStayOff({
      deviceMap,
      timing: {
        activeOvershoot: false,
        inCooldown: true,
        inStartupStabilization: false,
        restoreCooldownSeconds: 12,
        shedCooldownRemainingSec: 7,
        startupStabilizationRemainingSec: null,
      },
      setDevice,
    });
    expect(setDevice).toHaveBeenCalledWith(
      'dev1',
      expect.objectContaining({ reason: legacyDeviceReason('cooldown (shedding, 7s remaining)') }),
    );
    expect(setDevice).toHaveBeenCalledWith('ev1', expect.objectContaining({
      plannedState: 'inactive',
      reason: legacyDeviceReason('inactive (charger is unplugged)'),
    }));
    setDevice.mockClear();
    deviceMap.set('dev2', makeDevice({ id: 'dev2', name: 'Device 2', reason: legacyDeviceReason('shed due to capacity')!, powerKw: 2.2 }));

    markOffDevicesStayOff({
      deviceMap,
      timing: {
        activeOvershoot: false,
        inCooldown: false,
        inStartupStabilization: false,
        restoreCooldownSeconds: 9,
        shedCooldownRemainingSec: null,
        startupStabilizationRemainingSec: null,
      },
      setDevice,
      reasonOverride: (device) => ({ code: 'other', text: `blocked ${device.id}` }),
    });
    expect(setDevice).toHaveBeenCalledWith(
      'dev2',
      expect.objectContaining({ reason: { code: 'other', text: 'blocked dev2' } }),
    );
  });

  it('shares the same live eligibility gate across restore candidate paths', () => {
    const eligible = makeDevice({ id: 'eligible', currentState: 'off' });
    const stale = makeDevice({ id: 'stale', currentState: 'off' });
    const shed = makeDevice({ id: 'shed', currentState: 'off', plannedState: 'shed' });

    expect(isRestoreLiveEligibleDevice(eligible)).toBe(true);
    expect(isBinaryRestoreCandidate(eligible)).toBe(true);
    // Stale-off is now trusted-off (no staleness gate) -> a valid restore candidate.
    expect(isBinaryRestoreCandidate(stale)).toBe(true);
    expect(isBinaryRestoreCandidate(shed)).toBe(false);
  });

  it('does not treat target-only (not_applicable) devices as binary restore candidates', () => {
    // Target-only devices have no onoff capability — restore happens via the
    // temperature/target path, not via binary on. The defaulted currentOn flag
    // on the snapshot is not authoritative for "is this device off".
    const targetOnlyOff = makeDevice({
      id: 'target-only-off',
      currentState: 'not_applicable',
      binaryControl: { on: false },
    });

    expect(isBinaryRestoreCandidate(targetOnlyOff)).toBe(false);
  });
});
