import { resolveShedIntent } from '../../lib/device/deviceActionProjection';
import { getControlCapabilityId } from '../../lib/device/managerControl';
import type { TargetCapabilitySnapshot } from '../../packages/contracts/src/types';

const target = (
  overrides: Partial<TargetCapabilitySnapshot> = {},
): TargetCapabilitySnapshot => ({
  id: 'target_temperature',
  value: 21,
  min: 5,
  max: 30,
  step: 0.5,
  unit: '°C',
  ...overrides,
});

const steppedProfile = {
  steps: [
    { id: 'off', planningPowerW: 0, restoreFromOff: false },
    { id: 'low', planningPowerW: 800, restoreFromOff: true },
    { id: 'high', planningPowerW: 2000, restoreFromOff: false },
  ],
};

describe('resolveShedIntent', () => {
  it('returns turn_off for a simple binary device with shedBehavior turn_off', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'turn_off' },
      controllable: true,
      hasBinaryControl: true,
    })).toEqual({ kind: 'turn_off' });
  });

  it('returns set_temperature with normalised setpoint when behaviour is set_temperature and a primary target exists', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_temperature', temperature: 17.3 },
      controllable: true,
      hasBinaryControl: true,
      primaryTarget: target({ step: 0.5 }),
    })).toEqual({ kind: 'set_temperature', temperature: 17.5 });
  });

  it('clamps the setpoint to the target capability min/max', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_temperature', temperature: 100 },
      controllable: true,
      hasBinaryControl: true,
      primaryTarget: target({ min: 5, max: 28 }),
    })).toEqual({ kind: 'set_temperature', temperature: 28 });
  });

  it('falls back to turn_off when set_temperature is configured but no primary target exists', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_temperature', temperature: 18 },
      controllable: true,
      hasBinaryControl: true,
      primaryTarget: null,
    })).toEqual({ kind: 'turn_off' });
  });

  // The rung is the DEVICE's lowest active step. This used to be three cases —
  // configured stepId absent / matching / unknown — but a shed behaviour has
  // never been able to carry one, so they were one case wearing three hats.
  it('resolves set_step to the profile lowest active step, with or without binary control', () => {
    for (const hasBinaryControl of [true, false]) {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_step' },
        controllable: true,
        hasBinaryControl,
        steppedLoadProfile: steppedProfile,
      })).toEqual({ kind: 'set_step', targetStepId: 'low' });
    }
  });

  it('returns set_step for a stepped device with no binary control regardless of behaviour action', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'turn_off' },
      controllable: true,
      hasBinaryControl: false,
      steppedLoadProfile: steppedProfile,
    })).toEqual({ kind: 'set_step', targetStepId: 'low' });
  });

  it('returns turn_off for a stepped device with binary control and turn_off behaviour', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'turn_off' },
      controllable: true,
      hasBinaryControl: true,
      steppedLoadProfile: steppedProfile,
    })).toEqual({ kind: 'turn_off' });
  });

  it('returns turn_off for a non-stepped device even when set_step is configured', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_step' },
      controllable: true,
      hasBinaryControl: true,
    })).toEqual({ kind: 'turn_off' });
  });

  // This used to assert that a profile tagged with the wrong `model` fell back to
  // turn_off. That mistag is now rejected upstream, at the `unknown` parse
  // boundary (`normalizeSteppedLoadProfile`), so it cannot reach this seam at all
  // — and the tag itself is gone from `SteppedLoadProfile`. Note this does NOT
  // mean every degenerate profile is gone: `steps: []` is still representable, and
  // `resolveSetStepTargetStepId` handles it deliberately by answering `null`.
  // What the replacement covers is the reachable case this seam still decides:
  // absence. A device with no profile is not a stepped load, whatever else is set.
  it('returns turn_off for a device with no profile and no binary capability', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_step' },
      controllable: false,
      hasBinaryControl: false,
    })).toEqual({ kind: 'turn_off' });
  });

  // PR A: controllable folded into producer
  describe('controllable fold (PR A)', () => {
    it('collapses set_temperature to turn_off when controllable=false (non-stepped)', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_temperature', temperature: 17 },
        controllable: false,
        hasBinaryControl: true,
        primaryTarget: target(),
      })).toEqual({ kind: 'turn_off' });
    });

    it('collapses set_temperature to turn_off when controllable=false (stepped + binary)', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_temperature', temperature: 17 },
        controllable: false,
        hasBinaryControl: true,
        steppedLoadProfile: steppedProfile,
        primaryTarget: target(),
      })).toEqual({ kind: 'turn_off' });
    });

    it('keeps set_step for cap-off stepped device with no binary control (no other handle)', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_step' },
        controllable: false,
        hasBinaryControl: false,
        steppedLoadProfile: steppedProfile,
      })).toEqual({ kind: 'set_step', targetStepId: 'low' });
    });

    it('collapses set_step to turn_off when controllable=false on stepped+binary device', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_step' },
        controllable: false,
        hasBinaryControl: true,
        steppedLoadProfile: steppedProfile,
      })).toEqual({ kind: 'turn_off' });
    });
  });

  // De-drift edge (collapse of the redundant `hasBinaryControl` boolean):
  // a non-evcharger-class device that exposes `evcharger_charging` but no
  // `onoff` resolves to NO control capability — `getControlCapabilityId` only
  // returns 'evcharger_charging' for `deviceClass === 'evcharger'`. The legacy
  // `resolveHasBinaryControl` fallback used to call such a device binary by
  // scanning raw capabilities; collapsing onto `binaryCapabilityId`
  // intentionally drops that case, since PELS has no resolved capability to
  // command its binary state. The shed-intent gate must therefore treat it as
  // a non-binary (step-only fallback) device.
  describe('de-drift: evcharger_charging capability without evcharger class', () => {
    it('resolves no binaryCapabilityId for a non-evcharger device with only evcharger_charging', () => {
      expect(getControlCapabilityId({
        deviceClassKey: 'other',
        capabilities: ['evcharger_charging', 'evcharger_charging_state'],
      })).toBeUndefined();
    });

    it('treats such a stepped device as non-binary (set_step), not turn_off', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'turn_off' },
        controllable: true,
        // De-drift: no resolved control capability, so the binary gate is off.
        hasBinaryControl: false,
        steppedLoadProfile: steppedProfile,
      })).toEqual({ kind: 'set_step', targetStepId: 'low' });
    });
  });
});
